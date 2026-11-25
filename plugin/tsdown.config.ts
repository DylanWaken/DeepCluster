/** Monorepo-only build: the shared client preset and host tsconfig references require the DSH workspace. */
import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(import.meta.dirname, ['lib/types/index.js', 'lib/types/command.js', 'lib/types/api.js', 'lib/types/web.js', 'lib/types/telemetry.js', 'lib/types/team.js', 'lib/types/policy.js'], { hostPhase: true })
