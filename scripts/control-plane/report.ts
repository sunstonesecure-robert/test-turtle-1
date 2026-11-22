import { SCOPE_CHECK_IDS, type BootstrapReport } from '../../schemas/control-plane';

/** Inspection success describes readable prerequisites, never authority to load keys. */
export function bootstrapExitCode(report: BootstrapReport): 0 | 2 {
  const required = SCOPE_CHECK_IDS[report.scope];
  if (!required || report.api_effect === 'unknown' || report.checks.length !== required.length) return 2;
  return required.every(id => {
    const checks = report.checks.filter(c => c.id === id);
    return checks.length === 1 && (id === 'bootstrap_authority' ?
      checks[0]!.result === 'blocked' && checks[0]!.code === 'credential_effects_not_implemented' : checks[0]!.result === 'pass');
  }) ? 0 : 2;
}

const cell = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/\|/g, '&#124;').replace(/[\r\n]/g, ' ');

export function bootstrapSummary(report: BootstrapReport): string {
  const status = bootstrapExitCode(report) === 0 ? 'Scoped prerequisites pass; keys remain disallowed.' : 'Prerequisites failed or remain unknown.';
  const rows = report.checks.map(c => `| ${cell(c.id)} | ${c.result} | ${cell(c.code)} | ${cell(c.next_action)} |`);
  const users = report.access?.users.map(u => `${u.login} (${u.role})`).join(', ') ?? 'unknown';
  const teams = report.access ? report.access.teams.map(t => `${t.slug} (${t.permission})`).join(', ') || 'none' : 'unknown';
  return `## Broker bootstrap inspection\n\nScope: **${report.scope}**. ${status}\n\n` +
    `Source: ${cell(report.source_sha ?? 'unknown')}. Config: ${cell(report.config_sha256)}.\n\n` +
    `Administrator: ${cell(report.principal?.login ?? 'not bound in this scope')}.\n\nKeys allowed: **false**. Enrollment: **off**.\n\n` +
    '| Check | Result | Code | Next action |\n|---|---|---|---|\n' + rows.join('\n') +
    `\n\nEffective writers: ${cell(users)}\n\nTeams with write or above: ${cell(teams)}\n`;
}
