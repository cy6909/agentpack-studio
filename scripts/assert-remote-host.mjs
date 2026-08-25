import { networkInterfaces } from 'node:os'

const requiredAddress = '10.89.2.12'
const addresses = Object.values(networkInterfaces())
  .flatMap(entries => entries ?? [])
  .map(entry => entry.address)

if (!addresses.includes(requiredAddress)) {
  process.stderr.write(
    `Refusing to build or test on this host. Required address: ${requiredAddress}; observed: ${addresses.join(', ')}\n`,
  )
  process.exit(78)
}
