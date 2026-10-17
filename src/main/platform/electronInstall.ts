// Installs the Electron host. Imported first by the Electron entry point, so it is
// evaluated before any module that reads the platform.

import * as electron from 'electron'
import { installPlatform } from './index'
import { createElectronPlatform } from './electron'

installPlatform(createElectronPlatform(electron))
