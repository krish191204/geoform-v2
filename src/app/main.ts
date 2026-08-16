/**
 * App entry point.
 *
 * The shell mounts from here. Index HTML loads this file as a module;
 * everything else (topbar, stage UI, coach bar) is built by `mountApp`.
 */
import { mountApp } from './shell'

const root = document.getElementById('app-root')
if (root) mountApp(root)
