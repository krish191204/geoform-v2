/**
 * Interactive Geoform v2 briefing — a browser page, not a Cursor canvas.
 * Uses the live `gradeCritique` rubric so the sandbox cannot drift.
 */
import './briefing.css'
import type { Issue } from '../world/types'
import { gradeCritique } from '../critique/main'

type Lab =
  | 'tour'
  | 'rooms'
  | 'grade'
  | 'oven'
  | 'map'
  | 'quiz'
  | 'library'

type Exam = 'sketch' | 'world'

interface BriefingState {
  lab: Lab
  beat: number
  room: number
  exam: Exam
  selected: string[]
  oven: number
  lock: 'wiggle' | 'lock'
  layer: number
  moment: number
  temp: 'very-cold' | 'cold' | 'mild' | 'hot'
  swing: 'low' | 'high'
  moist: 'dry' | 'mid' | 'wet'
  alpine: boolean
  answers: Record<string, string>
}

const LABS: { id: Lab; label: string }[] = [
  { id: 'tour', label: 'Play a session' },
  { id: 'rooms', label: 'The four rooms' },
  { id: 'grade', label: 'Grade sandbox' },
  { id: 'oven', label: 'Make sense lab' },
  { id: 'map', label: 'Atlas decoder' },
  { id: 'quiz', label: 'Quiz' },
  { id: 'library', label: 'Full catalog' },
]

const TOUR = [
  {
    title: 'Empty ocean',
    click: 'Open the app. You are already in 01 Sketch.',
    see: 'Paper-textured sea. No continents. Stage rail shows Sketch.',
    panic: 'An empty ocean is the start state, not a missing map.',
    exists: 'Only a mask of zeros. No elevation, climate, or cities.',
  },
  {
    title: 'Stamp or paint land',
    click: 'Full continents, mixed, or islands — or the draw-land brush.',
    see: 'Flat khaki land, a soft coast, paper grain. No hillshade mountains.',
    panic: 'Climate chips and Planet are hidden. That is the product, not a bug.',
    exists: 'A soft 0–1 land mask on a 768×384 grid. Still no metres of height.',
  },
  {
    title: 'Shape the doodle',
    click: 'Erase gulfs. Add islands. Use a bigger brush. Leave poles mostly water.',
    see: 'A few large masses, some ocean, irregular shores.',
    panic: 'There is no raise-land tool. Pixel stairs get graded later.',
    exists: 'Still only the mask. Threshold 0.5 decides land versus sea.',
  },
  {
    title: 'Critique the napkin',
    click: 'Critique. This commits the mask.',
    see: 'Letter A–F for readiness, Pass/Watch/Concern/Fail rows, and a Fix line.',
    panic: 'F titled Not ready to ground is a drawing note. Climate does not exist yet.',
    exists: 'Same mask, now committed. Still no World arrays.',
  },
  {
    title: 'Make sense',
    click: 'Make sense. Wait through seven steps.',
    see: 'Freeze intent → Plates → Orogeny → Climate → Hydrology → Biomes → Suitability.',
    panic: 'Coasts wiggle. Continents should not teleport. 768×384 can take a while.',
    exists: 'A full World: metres, two seasons, rivers, biomes, suitability. Cities still empty.',
  },
  {
    title: 'Read Relief',
    click: 'Stay on Relief, or open Planet.',
    see: 'Muted green-brown paper map, hillshade, river ink — or the same arrays on a sphere.',
    panic: 'Compare this to Geoform 1, never Sketch versus the finished world.',
    exists: 'Same World. Layer chips are views, not new simulations.',
  },
  {
    title: 'Grade the planet',
    click: 'Critique again after Make sense.',
    see: 'A different rubric: climate, hydrology, tectonics, biomes, settlement, fidelity.',
    panic: 'A doodle F can become a coherent world. This is the real geography exam.',
    exists: 'Same World plus a grade with scope world.',
  },
  {
    title: 'Found towns',
    click: 'Worldbuild. Keep auto towns, or place/remove.',
    see: 'Settlements with jobs: seat, farmland, fishing, mine, hunt, trade, pastoral.',
    panic: 'Clicks on ocean, ice, or overcrowded cells are rejected on purpose.',
    exists: 'World plus cities. Suitability still decides who may live where.',
  },
] as const

const ROOMS = [
  {
    n: '01',
    label: 'Sketch',
    you: 'Paint land or sea. Stamp continents or islands. Clear sea. Inspect.',
    soft: 'Stores a soft 0–1 mask. Draws paper ocean and flat land.',
    map: 'Flat khaki land, antialiased coast, paper grain.',
    hidden: 'Hillshade mountains, biomes, Planet, climate chips. Raise/lower/ridge do not exist.',
    gate: 'Enter: always. Leave: Critique commits the mask.',
  },
  {
    n: '02',
    label: 'Critique',
    you: 'Read the letter, rubric, and Fix lines. Decide whether to redraw or proceed.',
    soft: 'Runs critiqueMask before Make sense, critiqueWorld after. Deterministic.',
    map: 'Issue overlays on the committed mask or derived world.',
    hidden: 'Critique never paints mountains to make the grade nicer.',
    gate: 'Enter: after commit. Leave: always. Make sense does not need a passing letter.',
  },
  {
    n: '03',
    label: 'Make sense',
    you: 'Press Make sense and wait. Optionally cancel.',
    soft: 'Copies the mask, grounds the coast, derives plates through suitability in a worker.',
    map: 'Seven-step progress, then Relief of the derived World.',
    hidden: 'Original doodle buffer is not overwritten. Area stays within ±5%.',
    gate: 'Enter: committed mask (score may be 0). Leave: only after a World exists.',
  },
  {
    n: '04',
    label: 'Worldbuild',
    you: 'Keep auto towns or place/remove. Inspect cells on Settle.',
    soft: 'Auto-seeds mixed roles. Rejects ocean, overcrowding, and unsuitably harsh clicks.',
    map: 'City marks on Relief or Settle.',
    hidden: 'You still cannot paint height unless you go back to Sketch.',
    gate: 'Enter: Make sense complete. Leave: always.',
  },
] as const

interface SandboxIssue {
  id: string
  exam: Exam
  severity: Issue['severity']
  ungraded?: boolean
  label: string
  why: string
}

const SANDBOX: SandboxIssue[] = [
  { id: 'too-little-land', exam: 'sketch', severity: 'critical', label: 'Too little land', why: 'Under 15% land.' },
  { id: 'too-much-land', exam: 'sketch', severity: 'critical', label: 'Too much land', why: 'Over 95% land.' },
  {
    id: 'not-a-planet-yet',
    exam: 'sketch',
    severity: 'critical',
    ungraded: true,
    label: 'Not a planet yet (scope)',
    why: 'Paint on water. Visible, but stripped from the letter.',
  },
  { id: 'polar-strip', exam: 'sketch', severity: 'major', label: 'Polar strip', why: 'Poles ringed with land.' },
  { id: 'scribble-coast', exam: 'sketch', severity: 'major', label: 'Scribble coast', why: 'Outline spray.' },
  { id: 'pixel-stairs', exam: 'sketch', severity: 'major', label: 'Pixel stairs', why: 'Brush-grid L-corners.' },
  { id: 'paint-holes', exam: 'sketch', severity: 'major', label: 'Paint holes', why: 'Inland ocean that never reaches a pole.' },
  { id: 'box-continent', exam: 'sketch', severity: 'major', label: 'Box continent', why: 'Filled rectangle, not a plate.' },
  { id: 'too-many-speckles', exam: 'sketch', severity: 'major', label: 'Too many speckles', why: 'More than eight 100-cell masses.' },
  { id: 'line-continent', exam: 'sketch', severity: 'minor', label: 'Line continent', why: 'A 1–2 cell strip.' },
  { id: 'ice-desert-dualism', exam: 'world', severity: 'critical', label: 'Ice next to hot desert', why: 'Impossible one-cell gradient.' },
  { id: 'rain-shadow-flipped', exam: 'world', severity: 'major', label: 'Rain shadow flipped', why: 'Lee wetter than windward.' },
  { id: 'no-continentality', exam: 'world', severity: 'major', label: 'No continentality', why: 'Interior does not swing more than the coast.' },
  { id: 'flux-on-maxima', exam: 'world', severity: 'major', label: 'Rivers on peaks', why: 'Water sitting on highs.' },
  { id: 'plate-stained-glass', exam: 'world', severity: 'major', label: 'Stained-glass plates', why: 'Voronoi cuts, not belts.' },
  { id: 'uniform-biome', exam: 'world', severity: 'major', label: 'One biome everywhere', why: 'Climate did no visible work.' },
  { id: 'all-capitals', exam: 'world', severity: 'minor', label: 'All capitals', why: 'Every town is a seat of power.' },
  { id: 'mask-drift', exam: 'world', severity: 'critical', label: 'Mask drift', why: 'Land area moved past ±5%.' },
]

const OVEN = [
  { name: 'Freeze intent', reads: 'Your mask', writes: 'Land-area fingerprint', note: 'Photograph the napkin. Lock budget ±5%.' },
  { name: 'Plates under mask', reads: 'Grounded mask + seed + radius', writes: 'plateId / velocities', note: 'Landmasses get 1–3 plates. Islands stay one. Never plate 0.' },
  { name: 'Orogeny', reads: 'Plate boundaries + mask', writes: 'elev in metres', note: 'Land base 200 m. CC +2000. OC trench −1000 / arc +1500. Peaks ≤ 8000 m.' },
  { name: 'Seasonal climate', reads: 'Elevation + latitude + tilt', writes: 'summer/winter °C and moisture', note: 'Equator 27 °C, poles −18 °C, lapse 6.5 °C/km. Not a GCM.' },
  { name: 'Hydrology', reads: 'Elevation + mask', writes: 'flux and rivers', note: 'D8 downhill. River where flux > 8. No fake boost.' },
  { name: 'Biomes', reads: 'tempMean + tempRange + summerMoist + elev', writes: '12 land labels + ocean', note: 'Alpine above 3500 m always wins. Never temperature alone.' },
  { name: 'Suitability', reads: 'biome + winter + rivers + coast', writes: '0–1 settle score', note: 'Manual place ≥ 0.4. Auto-seed may go to 0.28. Ice is zero.' },
] as const

const LAYERS = [
  { chip: 'Relief', means: 'Landform, hillshade, coast ink, river ink, paper grain.', mustNot: 'Not a biome paint-over.' },
  { chip: 'Biome', means: 'Twelve-class atlas palette plus ocean from the mask.', mustNot: 'Not prettier green instead of climate.' },
  { chip: 'Moisture', means: 'Precipitation index 0–1.', mustNot: 'Not a forest texture.' },
  { chip: 'Temperature', means: 'Mean temperature in °C.', mustNot: 'Always a temperature ramp.' },
  { chip: 'Settle', means: 'Where people can live, 0–1.', mustNot: 'Not city politics.' },
  { chip: 'Plates', means: 'Tectonic membership.', mustNot: 'Not stained-glass decoration.' },
  { chip: 'Height', means: 'Elevation in metres.', mustNot: 'Not Geoform 1’s 0–1 slider.' },
] as const

const MOMENTS = [
  { label: 'Empty ocean', mask: 'all sea', elev: 'none', climate: 'none', cities: 'none', pretty: 'paper grain only' },
  { label: 'After painting', mask: 'your doodle', elev: 'none', climate: 'none', cities: 'none', pretty: 'flat land + sea' },
  { label: 'After Critique', mask: 'committed doodle', elev: 'none', climate: 'none', cities: 'none', pretty: 'issue overlays' },
  { label: 'After Make sense', mask: 'grounded copy', elev: 'metres', climate: 'summer/winter + flux', cities: 'none yet', pretty: 'Relief and six other chips' },
  { label: 'After Worldbuild', mask: 'same world', elev: 'same metres', climate: 'same', cities: 'auto + authored', pretty: 'Settle layer + city marks' },
] as const

const QUIZ = [
  {
    id: 'q1',
    q: 'Sketch looks flat. What should you do?',
    options: [
      { id: 'a', label: 'Hunt for a raise-land brush', good: false, why: 'Those tools were retired so you cannot paint mountains that contradict plates.' },
      { id: 'b', label: 'Press Make sense, then look at Relief', good: true, why: 'Geography starts in the oven. Relief after Make sense is the fair picture.' },
      { id: 'c', label: 'Switch on the Biome chip during Sketch', good: false, why: 'Derived layers are withheld until a World exists so the doodle cannot lie.' },
    ],
  },
  {
    id: 'q2',
    q: 'Critique gives the doodle an F. Does that mean the planet is garbage?',
    options: [
      { id: 'a', label: 'Yes. The climate model already failed.', good: false, why: 'Climate does not exist yet. That F is readiness.' },
      { id: 'b', label: 'No. It grades the napkin. Make sense still runs at score 0.', good: true, why: 'Critique is advice, not a lock.' },
    ],
  },
  {
    id: 'q3',
    q: 'Make sense moved your coastline. Did it steal the continent?',
    options: [
      { id: 'a', label: 'Yes. Any shoreline change is a bug.', good: false, why: 'groundCoast is allowed to grow capes.' },
      { id: 'b', label: 'Only if land area drifted more than 5% or the mass teleported.', good: true, why: 'Mask lock protects continental intent, not every pixel of the outline.' },
    ],
  },
  {
    id: 'q4',
    q: 'What is the fair art comparison?',
    options: [
      { id: 'a', label: 'Sketch versus Geoform 1’s finished atlas', good: false, why: 'That compares a napkin to a printed sheet.' },
      { id: 'b', label: 'Relief after Make sense versus Geoform 1’s finished paper map', good: true, why: 'Same moment: geography exists, then it is photographed.' },
    ],
  },
  {
    id: 'q5',
    q: 'Ice sits next to hot desert in one cell. What letter cap applies?',
    options: [
      { id: 'a', label: 'B, because other categories might still score high', good: false, why: 'Averages cannot hide a critical.' },
      { id: 'b', label: 'F. ice-desert-dualism is a graded critical.', good: true, why: 'Any graded critical caps at 59 → F.' },
    ],
  },
] as const

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === undefined) continue
    if (v === true) node.setAttribute(k, '')
    else node.setAttribute(k, v)
  }
  for (const child of children) node.append(child instanceof Node ? child : document.createTextNode(child))
  return node
}

function mkIssue(def: SandboxIssue): Issue {
  return {
    id: def.id,
    severity: def.severity,
    title: def.label,
    critique: def.why,
    fix: '',
    evidence: [],
  }
}

function classifyBiome(
  temp: BriefingState['temp'],
  swing: BriefingState['swing'],
  moist: BriefingState['moist'],
  alpine: boolean,
): { id: string; why: string } {
  if (alpine) return { id: 'alpine', why: 'Elevation override above 3500 m always wins.' }
  if (temp === 'very-cold' && swing === 'high') return { id: 'ice', why: 'Very cold plus a large annual swing.' }
  if (temp === 'very-cold' && moist === 'dry') return { id: 'polar-desert', why: 'Cold, dry, and not continental enough for ice.' }
  if (temp === 'very-cold' || temp === 'cold') {
    if (moist === 'dry') return { id: 'boreal-desert', why: 'Cool and dry — more specific than taiga.' }
    if (temp === 'very-cold') return { id: 'tundra', why: 'Cold catch-all that is not ice or polar desert.' }
    return { id: 'taiga', why: 'Cool and wet enough for boreal forest.' }
  }
  if (temp === 'hot') {
    if (moist === 'dry') return { id: 'hot-desert', why: 'Hot and bone dry.' }
    if (moist === 'wet' && swing === 'low') return { id: 'rainforest', why: 'Hot, always-wet, small seasons.' }
    return { id: 'savanna', why: 'Hot with a wet-dry pulse.' }
  }
  if (moist === 'dry') return { id: 'steppe', why: 'Mild and dry enough for grassland.' }
  if (swing === 'low' && moist === 'mid') return { id: 'mediterranean', why: 'Mild coast, smaller seasons, mid moisture.' }
  return { id: 'temperate-forest', why: 'Mild and wet — the hospitable default.' }
}

export function defaultBriefingState(): BriefingState {
  return {
    lab: 'tour',
    beat: 0,
    room: 0,
    exam: 'sketch',
    selected: ['too-little-land', 'not-a-planet-yet'],
    oven: 0,
    lock: 'wiggle',
    layer: 0,
    moment: 1,
    temp: 'mild',
    swing: 'low',
    moist: 'wet',
    alpine: false,
    answers: {},
  }
}

function pills(
  items: readonly { id: string; label: string }[],
  active: string,
  onPick: (id: string) => void,
): HTMLElement {
  const row = el('div', { class: 'briefing-pills briefing-labs', role: 'tablist' })
  for (const item of items) {
    const btn = el('button', { type: 'button', 'aria-pressed': item.id === active ? 'true' : 'false' }, item.label)
    btn.addEventListener('click', () => onPick(item.id))
    row.append(btn)
  }
  return row
}

function renderLab(state: BriefingState, set: (patch: Partial<BriefingState>) => void): HTMLElement {
  if (state.lab === 'tour') {
    const step = TOUR[state.beat]
    const wrap = el('section')
    wrap.append(
      el('h2', {}, 'Play a session'),
      el('p', {}, `Beat ${state.beat + 1} of ${TOUR.length}. Click a number or use Next.`),
    )
    const nums = el('div', { class: 'briefing-pills briefing-labs' })
    TOUR.forEach((_, i) => {
      const btn = el('button', { type: 'button', 'aria-pressed': i === state.beat ? 'true' : 'false' }, String(i + 1).padStart(2, '0'))
      btn.addEventListener('click', () => set({ beat: i }))
      nums.append(btn)
    })
    wrap.append(nums)
    const card = el(
      'article',
      { class: 'briefing-card', 'data-beat': String(state.beat) },
      el('h3', {}, step.title),
      el('div', { class: 'briefing-grid two' },
        el('div', {}, el('h3', {}, 'You click'), el('p', {}, step.click)),
        el('div', {}, el('h3', {}, 'You should see'), el('p', {}, step.see)),
      ),
      el('div', { class: 'briefing-callout' }, el('strong', {}, 'Do not panic'), step.panic),
      el('p', {}, `What exists in memory: ${step.exists}`),
    )
    const actions = el('div', { class: 'briefing-actions' })
    const back = el('button', { type: 'button' }, 'Back')
    back.disabled = state.beat === 0
    back.addEventListener('click', () => set({ beat: state.beat - 1 }))
    const next = el('button', { type: 'button', class: 'primary' }, 'Next beat')
    next.disabled = state.beat === TOUR.length - 1
    next.addEventListener('click', () => set({ beat: state.beat + 1 }))
    const rooms = el('button', { type: 'button' }, 'Inspect this room')
    rooms.addEventListener('click', () => set({ lab: 'rooms' }))
    actions.append(back, next, rooms)
    wrap.append(card, actions)
    return wrap
  }

  if (state.lab === 'rooms') {
    const room = ROOMS[state.room]
    const wrap = el('section', {}, el('h2', {}, 'The four rooms'), el('p', {}, 'Click a room. Critique never blocks Make sense; Make sense does block Worldbuild until the oven finishes.'))
    const grid = el('div', { class: 'briefing-grid four briefing-rooms' })
    ROOMS.forEach((item, i) => {
      const btn = el('button', { type: 'button', class: 'room', 'aria-pressed': i === state.room ? 'true' : 'false' }, el('small', {}, item.n), el('strong', {}, item.label))
      btn.addEventListener('click', () => set({ room: i }))
      grid.append(btn)
    })
    wrap.append(
      grid,
      el('div', { class: 'briefing-grid two' },
        el('article', { class: 'briefing-card' }, el('h3', {}, 'You do'), el('p', {}, room.you)),
        el('article', { class: 'briefing-card' }, el('h3', {}, 'The software does'), el('p', {}, room.soft)),
      ),
      el('h3', {}, 'On the map'),
      el('p', {}, room.map),
      el('h3', {}, 'Deliberately hidden'),
      el('p', {}, room.hidden),
      el('h3', {}, 'Gates'),
      el('p', {}, room.gate),
    )
    return wrap
  }

  if (state.lab === 'grade') {
    const catalog = SANDBOX.filter((item) => item.exam === state.exam)
    const issues = catalog.filter((item) => state.selected.includes(item.id)).map(mkIssue)
    const grade = gradeCritique(issues, state.exam === 'sketch')
    const wrap = el(
      'section',
      {},
      el('h2', {}, 'Grade sandbox'),
      el('p', {}, 'This calls the real editor rubric. Tick findings or use a preset. The app UI hides the percentage; here you can see the math.'),
    )
    wrap.append(
      pills(
        [
          { id: 'sketch', label: 'Sketch exam' },
          { id: 'world', label: 'World exam' },
        ],
        state.exam,
        (id) =>
          set({
            exam: id as Exam,
            selected: id === 'sketch' ? ['too-little-land', 'not-a-planet-yet'] : ['ice-desert-dualism'],
          }),
      ),
    )
    const presets = el('div', { class: 'briefing-actions' })
    const presetBtns =
      state.exam === 'sketch'
        ? [
            ['Tiny island doodle', ['too-little-land', 'not-a-planet-yet']],
            ['Stamped rectangle', ['box-continent', 'pixel-stairs', 'not-a-planet-yet']],
            ['Ready-looking doodle', ['not-a-planet-yet']],
          ]
        : [
            ['Ice against desert', ['ice-desert-dualism']],
            ['Two majors', ['rain-shadow-flipped', 'uniform-biome']],
            ['Clean world', []],
          ]
    for (const [label, ids] of presetBtns) {
      const btn = el('button', { type: 'button' }, String(label))
      btn.addEventListener('click', () => set({ selected: ids as string[] }))
      presets.append(btn)
    }
    wrap.append(presets)
    const letter = el(
      'article',
      { class: 'briefing-card', 'data-letter': grade.letter, 'data-score': String(grade.score) },
      el('p', { class: 'briefing-letter' }, grade.letter),
      el('h3', {}, grade.title),
      el('p', {}, grade.summary),
      el('p', {}, `Internal score ${grade.score} (hidden in the editor).`),
    )
    const table = el('table', { class: 'briefing-table' }, el('thead', {}, el('tr', {}, el('th', {}, 'Criterion'), el('th', {}, 'Weight'), el('th', {}, 'Score'), el('th', {}, 'Status'))))
    const tbody = el('tbody')
    for (const row of grade.criteria) {
      tbody.append(el('tr', {}, el('td', {}, row.label), el('td', {}, String(row.weight)), el('td', {}, String(row.score)), el('td', {}, row.status)))
    }
    table.append(tbody)
    wrap.append(el('div', { class: 'briefing-grid two' }, letter, el('div', {}, el('h3', {}, 'Category scores'), table)))
    const list = el('div', { class: 'briefing-findings' })
    for (const item of catalog) {
      const box = el('input', { type: 'checkbox' }) as HTMLInputElement
      box.checked = state.selected.includes(item.id)
      box.addEventListener('change', () => {
        const next = state.selected.filter((id) => id !== item.id)
        if (box.checked) next.push(item.id)
        set({ selected: next })
      })
      list.append(el('label', {}, box, `${item.label} · ${item.ungraded ? 'ungraded critical' : item.severity} · ${item.why}`))
    }
    wrap.append(el('h3', {}, 'Toggle findings'), list)
    return wrap
  }

  if (state.lab === 'oven') {
    const step = OVEN[state.oven]
    const wrap = el('section', {}, el('h2', {}, 'Make sense lab'), el('p', {}, 'Click a step. Same mask plus same seed always yields the same planet.'))
    const nums = el('div', { class: 'briefing-pills briefing-labs' })
    OVEN.forEach((item, i) => {
      const btn = el('button', { type: 'button', 'aria-pressed': i === state.oven ? 'true' : 'false' }, `${i + 1} ${item.name}`)
      btn.addEventListener('click', () => set({ oven: i }))
      nums.append(btn)
    })
    wrap.append(
      nums,
      el('article', { class: 'briefing-card', 'data-oven': String(state.oven) },
        el('h3', {}, `${state.oven + 1}. ${step.name}`),
        el('div', { class: 'briefing-grid two' },
          el('div', {}, el('h3', {}, 'Reads'), el('p', {}, step.reads)),
          el('div', {}, el('h3', {}, 'Writes'), el('p', {}, step.writes)),
        ),
        el('div', { class: 'briefing-callout' }, el('strong', {}, 'The actual numbers'), step.note),
      ),
    )
    wrap.append(el('h3', {}, 'Coast wiggle versus continent lock'))
    wrap.append(
      pills(
        [
          { id: 'wiggle', label: 'groundCoast may wiggle' },
          { id: 'lock', label: 'mask lock may not teleport' },
        ],
        state.lock,
        (id) => set({ lock: id as BriefingState['lock'] }),
      ),
    )
    wrap.append(
      state.lock === 'wiggle'
        ? el('div', { class: 'briefing-callout' }, el('strong', {}, 'The atlas is supposed to look different'), 'A copy of the mask is meandered into capes. The original doodle is never written. Compare Relief after Make sense with Geoform 1.')
        : el('div', { class: 'briefing-callout warn' }, el('strong', {}, 'Land area stays within ±5%'), 'If the continent slides across the ocean, Make sense throws. Shoreline shape is flexible. Continental intent is not.'),
    )
    const bars = el('div', { class: 'briefing-bars' })
    const peaks = [
      ['CC range', 2000, 2200, false],
      ['OC arc', 1500, 2200, false],
      ['OC trench', -1000, 2200, true],
      ['Divergent', -500, 2200, true],
      ['Shelf', 50, 2200, false],
    ] as const
    for (const [label, value, max, neg] of peaks) {
      const fill = el('i')
      fill.style.width = `${(Math.abs(value) / max) * 100}%`
      bars.append(
        el('div', { class: 'briefing-bar-row' },
          el('span', {}, label),
          el('div', { class: `briefing-bar${neg ? ' neg' : ''}` }, fill),
          el('span', {}, `${value} m`),
        ),
      )
    }
    wrap.append(el('h3', {}, 'Orogeny peaks by boundary class'), bars, el('p', {}, 'Peak elevation change in metres. Source: src/pipeline/orogeny.ts.'))
    return wrap
  }

  if (state.lab === 'map') {
    const layer = LAYERS[state.layer]
    const moment = MOMENTS[state.moment]
    const biome = classifyBiome(state.temp, state.swing, state.moist, state.alpine)
    const wrap = el('section', {}, el('h2', {}, 'Atlas decoder'), el('p', {}, 'Layers are photographs of arrays. Switching a chip never mutates geography.'))
    wrap.append(el('h3', {}, 'Layer chips'))
    const layerRow = el('div', { class: 'briefing-pills briefing-labs' })
    LAYERS.forEach((item, i) => {
      const btn = el('button', { type: 'button', 'aria-pressed': i === state.layer ? 'true' : 'false' }, item.chip)
      btn.addEventListener('click', () => set({ layer: i }))
      layerRow.append(btn)
    })
    wrap.append(layerRow, el('div', { class: 'briefing-callout' }, el('strong', {}, layer.chip), `${layer.means} ${layer.mustNot}`))
    wrap.append(el('h3', {}, 'What exists in memory'))
    const momentRow = el('div', { class: 'briefing-pills briefing-labs' })
    MOMENTS.forEach((item, i) => {
      const btn = el('button', { type: 'button', 'aria-pressed': i === state.moment ? 'true' : 'false' }, item.label)
      btn.addEventListener('click', () => set({ moment: i }))
      momentRow.append(btn)
    })
    const table = el('table', { class: 'briefing-table' })
    table.append(
      el('tbody', {},
        el('tr', {}, el('th', {}, 'Mask'), el('td', {}, moment.mask)),
        el('tr', {}, el('th', {}, 'Elevation'), el('td', {}, moment.elev)),
        el('tr', {}, el('th', {}, 'Climate / rivers'), el('td', {}, moment.climate)),
        el('tr', {}, el('th', {}, 'Cities'), el('td', {}, moment.cities)),
        el('tr', {}, el('th', {}, 'Pretty layers'), el('td', {}, moment.pretty)),
      ),
    )
    wrap.append(momentRow, table, el('h3', {}, 'Biome mixer'))
    const mix = el('div', { class: 'briefing-grid four' })
    const selects: [keyof Pick<BriefingState, 'temp' | 'swing' | 'moist'>, string, { value: string; label: string }[]][] = [
      ['temp', 'Mean temperature', [
        { value: 'very-cold', label: 'Very cold' },
        { value: 'cold', label: 'Cold / cool' },
        { value: 'mild', label: 'Mild' },
        { value: 'hot', label: 'Hot' },
      ]],
      ['swing', 'Seasonal swing', [
        { value: 'low', label: 'Low (coastal)' },
        { value: 'high', label: 'High (continental)' },
      ]],
      ['moist', 'Summer moisture', [
        { value: 'dry', label: 'Dry' },
        { value: 'mid', label: 'Mid' },
        { value: 'wet', label: 'Wet' },
      ]],
    ]
    for (const [key, label, options] of selects) {
      const select = el('select') as HTMLSelectElement
      for (const opt of options) select.append(el('option', { value: opt.value }, opt.label))
      select.value = String(state[key])
      select.addEventListener('change', () => set({ [key]: select.value } as Partial<BriefingState>))
      mix.append(el('label', {}, el('h3', {}, label), select))
    }
    const alpine = el('input', { type: 'checkbox' }) as HTMLInputElement
    alpine.checked = state.alpine
    alpine.addEventListener('change', () => set({ alpine: alpine.checked }))
    mix.append(el('label', {}, el('h3', {}, 'Alpine override'), alpine, ' Above 3500 m'))
    wrap.append(mix, el('div', { class: 'briefing-stat', 'data-biome': biome.id }, el('b', {}, biome.id), el('span', {}, biome.why)))
    return wrap
  }

  if (state.lab === 'quiz') {
    const wrap = el('section', {}, el('h2', {}, 'Quiz'))
    const answered = QUIZ.filter((item) => state.answers[item.id])
    const correct = answered.filter((item) => item.options.find((opt) => opt.id === state.answers[item.id])?.good).length
    if (answered.length > 0) {
      wrap.append(el('div', { class: 'briefing-stat', 'data-quiz-score': `${correct}/${answered.length}` }, el('b', {}, `${correct} / ${answered.length}`), el('span', {}, 'Correct of answered')))
    }
    QUIZ.forEach((item, index) => {
      const block = el('article', { class: 'briefing-card' }, el('h3', {}, `${index + 1}. ${item.q}`))
      for (const option of item.options) {
        const btn = el('button', { type: 'button', class: 'briefing-quiz-opt' }, option.label)
        if (state.answers[item.id] === option.id) btn.setAttribute('aria-pressed', 'true')
        btn.addEventListener('click', () => set({ answers: { ...state.answers, [item.id]: option.id } }))
        block.append(btn)
      }
      const pick = item.options.find((opt) => opt.id === state.answers[item.id])
      if (pick) {
        block.append(el('div', { class: `briefing-callout ${pick.good ? 'ok' : 'bad'}` }, el('strong', {}, pick.good ? 'Correct' : 'Not quite'), pick.why))
      }
      wrap.append(block)
    })
    if (answered.length > 0) {
      const reset = el('button', { type: 'button' }, 'Reset quiz')
      reset.addEventListener('click', () => set({ answers: {} }))
      wrap.append(el('div', { class: 'briefing-actions' }, reset))
    }
    return wrap
  }

  const wrap = el('section', {}, el('h2', {}, 'Full catalog'), el('p', {}, 'Static lists for the same rules the labs animate.'))
  const defaults = el('table', { class: 'briefing-table' })
  defaults.append(
    el('tbody', {},
      el('tr', {}, el('th', {}, 'Grid'), el('td', {}, '768×384, 2:1 equirectangular')),
      el('tr', {}, el('th', {}, 'Threshold'), el('td', {}, '0.5')),
      el('tr', {}, el('th', {}, 'Planet radius'), el('td', {}, '6371 km (range 2000–50000)')),
      el('tr', {}, el('th', {}, 'Saves'), el('td', {}, 'geoform.mask.v2 and geoform.world.v2 in this browser. v1 heightfield saves are ignored.')),
    ),
  )
  wrap.append(el('h3', {}, 'Defaults'), defaults)
  wrap.append(
    el('div', { class: 'briefing-callout warn' },
      el('strong', {}, 'Python WorldEngine is not the live path'),
      'The README still describes a 320×160 paint-heightfield app talking to FastAPI. v2 generates in the browser.',
    ),
  )
  return wrap
}

export function renderBriefing(state: BriefingState, set: (patch: Partial<BriefingState>) => void): HTMLElement {
  const root = el('div', { class: 'briefing' })
  root.append(
    el(
      'div',
      { class: 'briefing-top' },
      el('a', { class: 'briefing-brand', href: '/' }, 'Geoform'),
      el('a', { class: 'briefing-back', href: '/' }, 'Back to the editor'),
    ),
    el('p', { class: 'briefing-kicker' }, 'Interactive briefing · v2 mask-first pipeline'),
    el('h1', {}, 'Drive the planet yourself'),
    el('p', {}, 'Click through a session, fail a doodle on purpose, watch a letter grade change, and step the geography oven. This page uses the same grading function as the editor.'),
    el('div', { class: 'briefing-callout warn' }, el('strong', {}, 'The one idea'), 'Sketch is land versus water. Mountains, climate, rivers, and biomes do not exist until Make sense. If Sketch looks flat, that is correct.'),
  )
  const stats = el('div', { class: 'briefing-grid four' })
  for (const [value, label] of [
    ['768×384', 'Equirectangular grid, 2:1'],
    ['4 stages', 'Sketch → Critique → Sense → Cities'],
    ['7 steps', 'Make sense geography chain'],
    ['12 biomes', 'Plus ocean as a mask, not a biome'],
  ] as const) {
    stats.append(el('div', { class: 'briefing-stat' }, el('b', {}, value), el('span', {}, label)))
  }
  root.append(stats)
  const labNav = el('div', { class: 'briefing-labs', role: 'tablist', 'aria-label': 'Briefing labs' })
  for (const lab of LABS) {
    const btn = el('button', { type: 'button', 'data-lab': lab.id, 'aria-pressed': lab.id === state.lab ? 'true' : 'false' }, lab.label)
    btn.addEventListener('click', () => set({ lab: lab.id }))
    labNav.append(btn)
  }
  root.append(labNav, renderLab(state, set))
  return root
}

export function mountBriefing(host: HTMLElement, initial: BriefingState = defaultBriefingState()): { getState(): BriefingState } {
  let state = { ...initial, selected: [...initial.selected], answers: { ...initial.answers } }
  const paint = (): void => {
    const set = (patch: Partial<BriefingState>): void => {
      state = { ...state, ...patch }
      paint()
    }
    host.replaceChildren(renderBriefing(state, set))
  }
  paint()
  return {
    getState: () => state,
  }
}

const root = document.getElementById('briefing-root')
if (root) mountBriefing(root)
