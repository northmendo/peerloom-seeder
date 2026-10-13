export const DEFAULT_LANG = 'en_US'

const dict = {
  'Starting PeerLoom Seeder': 0,
  Dashboard: 1,
  'The dashboard is ready': 2,
  'The dashboard is not ready': 3,
  'Pair devices and see what the seeder holds': 4,
  'Show password': 5,
  'The password the dashboard asks for': 6,
  'Dashboard password': 7,
  'Enter this on the dashboard.': 8,
  'Start the seeder once to make the password.': 9,
} as const

/**
 * Plumbing. DO NOT EDIT.
 */
export type I18nKey = keyof typeof dict
export type LangDict = Record<(typeof dict)[I18nKey], string>
export default dict
