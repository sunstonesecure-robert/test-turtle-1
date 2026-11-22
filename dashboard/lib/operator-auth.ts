import bootstrap from '../../control-plane/broker-bootstrap.json';
import { BrokerBootstrap } from '../../schemas/control-plane';
import { DeviceSignIn } from './github/auth';

// Next may bundle routes separately. One vault per server process, including
// development reloads; credentials never enter browser props, files or logs.
const key = Symbol.for('agentic-turtles.operator-device-sign-in');
const vault = globalThis as typeof globalThis & { [key]?: DeviceSignIn };
export function operatorSignIn() {
  const app = BrokerBootstrap.parse(bootstrap).apps.operator_sign_in;
  return vault[key] ??= new DeviceSignIn({ app_id: app.app_id, client_id: app.client_id, slug: app.slug });
}
