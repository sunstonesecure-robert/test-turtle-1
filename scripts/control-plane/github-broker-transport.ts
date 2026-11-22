import { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { RepositoryIdentity, sha256 } from '../../schemas/control-plane';
import { BrokerFailure, type BrokerTransport } from './broker';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const planSchema = z.object({
  customer_id: z.string().min(1), request_id: z.string().min(1), request_digest: sha256,
  app_id: id, installation_id: id, repositories: z.array(RepositoryIdentity).length(1),
  permissions: z.object({ metadata: z.literal('read') }).strict(),
}).strict();
const headers = { 'X-GitHub-Api-Version': '2026-03-10' };
const log = { debug() {}, info() {}, warn() {}, error() {} };

/** The caller supplies an App-authenticated client from isolated broker code.
 * This adapter never locates, loads or retains a private key. It has no default
 * auth strategy and cannot broaden a metadata read to a mutation. The native
 * response is verified by the broker before any credentialed GET.
 * API: https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app
 */
export function githubBrokerTransport(app: Octokit): BrokerTransport {
  const installation = (token: string) => new Octokit({ auth: token, log });
  return {
    async mint(rawPlan) {
      const plan = planSchema.parse(rawPlan);
      const principal = z.object({ id, owner: z.object({ login: z.literal('SunStone-Secure-LLC') }) })
        .parse((await app.apps.getAuthenticated({ headers })).data);
      if (principal.id !== plan.app_id) throw new BrokerFailure('app_identity_changed');
      const native = z.object({ id, app_id: id, account: z.object({ login: z.string() }), suspended_at: z.null() })
        .parse((await app.apps.getInstallation({ installation_id: plan.installation_id, headers })).data);
      if (native.id !== plan.installation_id || native.app_id !== plan.app_id ||
          plan.repositories.some(repo => repo.full_name.split('/')[0]!.toLowerCase() !== native.account.login.toLowerCase())) {
        throw new BrokerFailure('installation_identity_changed');
      }
      // Omitting either field would inherit the installation's wider defaults.
      return (await app.apps.createInstallationAccessToken({ installation_id: plan.installation_id,
        repository_ids: plan.repositories.map(repo => repo.id), permissions: plan.permissions, headers })).data;
    },
    async read(token, rawRepository) {
      const repository = RepositoryIdentity.parse(rawRepository);
      const [owner, repo] = repository.full_name.split('/') as [string, string];
      return (await installation(token).repos.get({ owner, repo, headers })).data;
    },
    async revoke(token) { await installation(token).apps.revokeInstallationAccessToken({ headers }); },
  };
}
