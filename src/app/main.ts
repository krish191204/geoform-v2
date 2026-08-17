/**
 * App entry point.
 *
 * The shell mounts from here. Index HTML loads this file as a module;
 * everything else (chrome, atlas, coach, inspector) is built by `mountApp`.
 */
import '../style.css'
import { mountApp } from './shell'

const root = document.getElementById('app-root')
if (root) mountApp(root)
