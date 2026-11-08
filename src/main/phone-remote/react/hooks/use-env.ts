import { useCallback, useEffect, useState } from 'react'
import type { SupabaseEnvName } from '@shared/config'
import type { EnvSwitcherState } from '../SettingsBody'
import type { SocketBus } from '../socket-bus'
import type { UseConnectionResult } from './use-connection'

interface UseEnvArgs {
  bus: SocketBus
  send: UseConnectionResult['send']
}

/** Owns admin env switcher state and the in-flight restart banner. */
export function useEnv({ bus, send }: UseEnvArgs) {
  // Admin env switcher. null until the Mac answers 'getEnv' — the control stays
  // hidden until then, so a non-admin never sees it flash in and disappear.
  const [envState, setEnvState] = useState<EnvSwitcherState | null>(null)
  // Non-null while the Mac is quitting/relaunching for an env switch. Drives the
  // "restarting" banner INSTEAD of the generic disconnect copy, and is cleared
  // only by a fresh 'env' frame — i.e. the Mac is genuinely back and answering.
  const [envSwitchingTo, setEnvSwitchingTo] = useState<SupabaseEnvName | null>(null)

  useEffect(() => {
    const unsubscribers = [
      bus.subscribe('env', (msg) => {
        setEnvState({
          isAdmin: msg.isAdmin,
          current: msg.current,
          buildDefault: msg.buildDefault
        })
        // A fresh 'env' means the Mac is up and answering, so whatever switch
        // was in flight has landed. Clearing here (rather than on reconnect)
        // keeps the banner up until the NEW env is actually confirmed.
        setEnvSwitchingTo(null)
      }),
      bus.subscribe('envSwitching', (msg) => {
        setEnvSwitchingTo(msg.to)
      })
    ]
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
  }, [bus])

  const onEnvChange = useCallback(
    (value: SupabaseEnvName) => send({ type: 'setEnv', value }),
    [send]
  )
  // Fire-and-forget: the Mac validates admin, writes the override, then
  // quits and relaunches. The only reply is `envSwitching`, which flips
  // the banner just before the socket drops.

  return { envState, envSwitchingTo, onEnvChange }
}
