/**
 * Deep time panel: the planet under the map — its physics, its bedrock,
 * its resources, and the long history the land allows. Reads the grounded
 * World only; every sibling reader is fenced so one failure hides one block.
 */

import type { World } from '../world/types'
import { formatPlanetCard, planetCard } from '../science/planetPhysics'
import { geologySummary, LITHOLOGY_COLOR, readGeology, type GeologyReading } from '../sketch/geology'
import { deepHistory, type HistoryEra } from '../sketch/deepHistory'
import { readResources, resourceSummary } from '../sketch/resources'

export interface DeepTimeModel {
  facts: string[]
  rocks: { label: string; share: number; color: string }[]
  resources: { label: string; cells: number }[]
  eras: HistoryEra[]
}

const MAX_ROCKS = 6
const FALLBACK_ROCK_COLOR = '#b8a88a'
const HEX_COLOR = /^#[0-9a-f]{3,8}$/i
const LEDE = 'The planet under the map: its physics, its rocks, and the long history the land allows.'
const EMPTY_COPY = 'Make sense first. Deep time reads the grounded world.'

const NUMBER = new Intl.NumberFormat('en')

function attempt<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

function hasLand(world: World): boolean {
  const { elev } = world
  for (let i = 0; i < elev.length; i++) if (elev[i] > 0) return true
  return false
}

function emptyModel(): DeepTimeModel {
  return { facts: [], rocks: [], resources: [], eras: [] }
}

/** Reads every deep-time source once. Geology is computed here unless passed in. */
export function buildDeepTimeModel(world: World, geology?: GeologyReading): DeepTimeModel {
  if (!hasLand(world)) return emptyModel()

  const facts = attempt(() => formatPlanetCard(planetCard(world.meta)), [])
  const g = geology ?? attempt<GeologyReading | null>(() => readGeology(world), null)

  const rocks = g
    ? attempt(
        () =>
          [...geologySummary(world, g)]
            .filter((r) => r.share > 0)
            .sort((a, b) => b.share - a.share)
            .slice(0, MAX_ROCKS)
            .map((r) => ({
              label: r.label,
              share: Math.min(1, r.share),
              color: rockColor(LITHOLOGY_COLOR[r.lith]),
            })),
        [],
      )
    : []

  const resources = g
    ? attempt(
        () =>
          [...resourceSummary(readResources(world, g.lith))]
            .filter((r) => r.cells > 0)
            .sort((a, b) => b.cells - a.cells)
            .map((r) => ({ label: r.label, cells: r.cells })),
        [],
      )
    : []

  const eras = attempt(() => deepHistory(world), [])

  return { facts, rocks, resources, eras }
}

function rockColor(color: string | undefined): string {
  return color && HEX_COLOR.test(color) ? color : FALLBACK_ROCK_COLOR
}

function isEmptyModel(model: DeepTimeModel): boolean {
  return model.facts.length === 0 && model.rocks.length === 0 && model.resources.length === 0 && model.eras.length === 0
}

function textEl<K extends keyof HTMLElementTagNameMap>(tag: K, className: string | null, text: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  node.textContent = text
  return node
}

function block(kind: string, heading: string): HTMLDivElement {
  const div = document.createElement('div')
  div.className = `deep-time-block ${kind}`
  div.append(textEl('h3', null, heading))
  return div
}

function formatShare(share: number): string {
  const pct = Math.round(share * 100)
  return share > 0 && pct === 0 ? '<1%' : `${NUMBER.format(pct)}%`
}

function formatYears([a, b]: [number, number]): string {
  const older = Math.max(a, b)
  const younger = Math.min(a, b)
  const span = older === younger ? NUMBER.format(older) : `${NUMBER.format(older)}–${NUMBER.format(younger)}`
  return `${span} years before the map`
}

function planetBlock(facts: string[]): HTMLElement {
  const div = block('deep-time-planet', 'Planet')
  const list = document.createElement('ul')
  list.className = 'deep-time-facts'
  for (const fact of facts) list.append(textEl('li', null, fact))
  div.append(list)
  return div
}

function rocksBlock(rocks: DeepTimeModel['rocks']): HTMLElement {
  const div = block('deep-time-rocks', 'Bedrock')
  for (const rock of rocks.slice(0, MAX_ROCKS)) {
    const bar = document.createElement('div')
    bar.className = 'rock-bar'
    bar.style.setProperty('--share', String(Math.round(Math.max(0, Math.min(1, rock.share)) * 1000) / 1000))
    bar.style.setProperty('--color', rockColor(rock.color))
    bar.append(
      textEl('span', 'rock-swatch', ''),
      textEl('span', 'rock-label', rock.label),
      textEl('span', 'rock-share', formatShare(rock.share)),
    )
    div.append(bar)
  }
  return div
}

function resourcesBlock(resources: DeepTimeModel['resources']): HTMLElement {
  const div = block('deep-time-resources', 'Resources')
  const list = document.createElement('ul')
  list.className = 'deep-time-resource-list'
  for (const res of resources) {
    const item = document.createElement('li')
    item.append(
      textEl('span', 'res-label', res.label),
      textEl('span', 'res-cells', `${NUMBER.format(res.cells)} ${res.cells === 1 ? 'cell' : 'cells'}`),
    )
    list.append(item)
  }
  div.append(list)
  return div
}

function erasBlock(eras: HistoryEra[], onPlace?: (x: number, y: number) => void): HTMLElement {
  const div = block('deep-time-eras', 'Long history')
  const list = document.createElement('ol')
  list.className = 'era-list'
  for (const era of eras) {
    const item = document.createElement('li')
    item.className = 'era'
    item.dataset.theme = era.theme
    item.append(
      textEl('span', 'era-years', formatYears(era.yearsAgo)),
      textEl('span', 'era-title', era.title),
      textEl('p', 'era-why', era.why),
    )
    for (const place of era.places) {
      const button = textEl('button', 'era-place', place.label)
      button.type = 'button'
      button.dataset.x = String(place.x)
      button.dataset.y = String(place.y)
      button.addEventListener('click', () => onPlace?.(place.x, place.y))
      item.append(button)
    }
    list.append(item)
  }
  div.append(list)
  return div
}

function appendBlock(section: HTMLElement, build: () => HTMLElement): void {
  try {
    section.append(build())
  } catch {
    // A malformed reading hides its own block, never the panel.
  }
}

export function mountDeepTimePanel(model: DeepTimeModel, onPlace?: (x: number, y: number) => void): HTMLElement {
  const section = document.createElement('section')
  section.className = 'deep-time'
  section.setAttribute('aria-label', 'Deep time')
  section.append(textEl('h2', 'deep-time-title', 'Deep time'))

  if (isEmptyModel(model)) {
    section.append(textEl('p', 'deep-time-empty', EMPTY_COPY))
    return section
  }

  section.append(textEl('p', 'deep-time-lede', LEDE))
  if (model.facts.length > 0) appendBlock(section, () => planetBlock(model.facts))
  if (model.rocks.length > 0) appendBlock(section, () => rocksBlock(model.rocks))
  if (model.resources.length > 0) appendBlock(section, () => resourcesBlock(model.resources))
  if (model.eras.length > 0) appendBlock(section, () => erasBlock(model.eras, onPlace))
  return section
}
