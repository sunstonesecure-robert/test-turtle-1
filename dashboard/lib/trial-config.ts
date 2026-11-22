import bootstrap from '../../control-plane/broker-bootstrap.json';
import { BrokerBootstrap } from '../../schemas/control-plane';
import { TrialReviewConfig } from './trial-http';

export function trialReviewConfig() {
  const config = BrokerBootstrap.parse(bootstrap);
  return TrialReviewConfig.parse({ control: config.broker, state: config.state, audit: config.audit, governed: config.governed,
    proposal_path: 'trials/authorization.json' });
}
