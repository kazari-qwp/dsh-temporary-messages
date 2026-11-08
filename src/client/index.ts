import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import { remoteContribution } from '../remote-contract.ts'
import { ENTRY_ID, type Settings } from '../shared.ts'
import { SettingsPage } from './settings.tsx'

export const inject = ['slots', 'configForms', 'remote']

export async function apply(ctx: Context): Promise<void> {
  const remote = ctx.get('remote') as TypertClientRemote
  const unmount = await remote.$mount(remoteContribution)
  ctx.effect(() => unmount)
  const form = ctx.configForms.get<Settings>(ENTRY_ID)
  // 接口先挂载，再声明对其命名空间的依赖。
  ctx.inject(['remote.temporaryMessagesUi'], child => {
    const api = (child.get('remote') as TypertClientRemote).temporaryMessagesUi
    child.effect(() => child.configForms.whileServed([ENTRY_ID], () =>
      child.slots.inject('settings.section', () => child.slots.register({
        name: 'settings.section', id: ENTRY_ID, order: 45,
        label: () => '临时消息',
        inject: () => ({ form, api }),
      }, SettingsPage)),
    ))
  })
}
