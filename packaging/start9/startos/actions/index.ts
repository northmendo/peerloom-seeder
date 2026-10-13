import { sdk } from '../sdk'
import { showPassword } from './showPassword'

export const actions = sdk.Actions.of().addAction(showPassword)
