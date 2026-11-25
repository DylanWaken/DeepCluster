/**
 * The machine-wide DeepCluster master directory inside the DSH checkout that hosts the service.
 *
 * It holds the service's own state: `service/` (launch scripts, per-start logs, recorded
 * ownership), `api-state/` (operation records and the API owner lock), `leases/` (hardware
 * leases), and `claims/` plus `claim-history.json` (write claims). Per-project run files stay
 * in each workspace's `.deep-cluster/` directory.
 *
 * @module @deepseek-ai/dsh-experimental-deep-cluster/master
 */

import path from 'node:path'

/**
 * Resolve the master directory; every owner of leases and claims on this computer must use it.
 * @param dshPath - saved DSH checkout; absent fails loudly instead of choosing another location.
 * @returns `<dshPath>/.deep-cluster/service-state`.
 */
export function masterDirectory(dshPath: string | undefined): string {
  if (dshPath === undefined) {
    throw new Error('DeepCluster master directory requires the saved dshPath; run `dsh --profile deep-cluster install --dsh-path <DSH checkout>`.')
  }
  return path.join(path.resolve(dshPath), '.deep-cluster', 'service-state')
}
