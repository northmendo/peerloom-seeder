import { sdk } from '../sdk'
import { i18n } from '../i18n'

// The dashboard password: made on first start and saved in the data volume
// by @peerloom/host's dashboard-auth (file name PASSWORD_FILE).
export const showPassword = sdk.Action.withoutInput(
  'show-password',
  async () => ({
    name: i18n('Show password'),
    description: i18n('The password the dashboard asks for'),
    warning: null,
    allowedStatuses: 'any',
    group: null,
    visibility: 'enabled',
  }),
  async () => {
    let value: string | null = null
    try {
      value = String(await sdk.volumes.main.readFile('dashboard-password', 'utf8')).trim()
    } catch {}
    return {
      version: '1',
      title: i18n('Dashboard password'),
      message: value
        ? i18n('Enter this on the dashboard.')
        : i18n('Start the seeder once to make the password.'),
      result: value
        ? { type: 'single', value, copyable: true, qr: false, masked: true }
        : null,
    }
  },
)
