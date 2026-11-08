/**
 * Thrown by a platform implementation when a capability has no real
 * implementation on the current OS yet.
 *
 * This is the HONEST failure mode that replaced the old silent fake-pass
 * (non-darwin used to return `{ ok: true }` / `''` and look alive while doing
 * nothing). A loud throw surfaces "this OS isn't supported" instead.
 */
export class PlatformNotSupportedError extends Error {
  constructor(
    public readonly platform: NodeJS.Platform,
    public readonly capability: string
  ) {
    super(`${capability} is not supported on platform "${platform}" yet.`)
    this.name = 'PlatformNotSupportedError'
  }
}
