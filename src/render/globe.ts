/**
 * 3D globe of the same World arrays. Ported from Geoform 1's PlanetView:
 * color / bump / normal / displacement / roughness textures baked from draw.ts.
 */
import * as THREE from 'three'
import {
  bakeBumpImageData,
  bakeDisplacementImageData,
  bakeNormalImageData,
  bakeRoughnessImageData,
  bakeWorldImageDataSmooth,
  type Season,
} from './draw'
import type { Layer, World } from '../world/types'

const BAKE = 6
const WIDTH_SEG = 192
const HEIGHT_SEG = 128
const DISPLACE = 0.065
const TEX_MAX = 4096

function imageDataToTexture(
  image: ImageData,
  renderer: THREE.WebGLRenderer,
  opts: { srgb?: boolean; mipmaps?: boolean } = {},
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const ctx = canvas.getContext('2d')!
  ctx.putImageData(image, 0, 0)
  const tex = new THREE.CanvasTexture(canvas)
  // Color maps are sRGB; bump/normal/displacement/roughness stay linear.
  tex.colorSpace = opts.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy())
  const mipmaps = opts.mipmaps ?? true
  tex.generateMipmaps = mipmaps
  tex.minFilter = mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.needsUpdate = true
  return tex
}

export class PlanetView {
  readonly canvas: HTMLCanvasElement
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private globe: THREE.Mesh
  private atmosphere: THREE.Mesh
  private sun: THREE.DirectionalLight
  private fill: THREE.DirectionalLight
  private colorTex: THREE.CanvasTexture | null = null
  private bumpTex: THREE.CanvasTexture | null = null
  private normalTex: THREE.CanvasTexture | null = null
  private dispTex: THREE.CanvasTexture | null = null
  private roughTex: THREE.CanvasTexture | null = null
  private yaw = 0.85
  private pitch = 0.22
  private distance = 3.15
  private dragging = false
  private lastX = 0
  private lastY = 0
  private cacheKey = ''
  private terrainKey = ''

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05

    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 40)

    this.globe = new THREE.Mesh(
      new THREE.SphereGeometry(1, WIDTH_SEG, HEIGHT_SEG),
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.82,
        metalness: 0.03,
      }),
    )
    this.scene.add(this.globe)

    this.atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.045, 72, 54),
      new THREE.MeshBasicMaterial({
        color: 0x8ec8e8,
        transparent: true,
        opacity: 0.16,
        side: THREE.BackSide,
        depthWrite: false,
      }),
    )
    this.scene.add(this.atmosphere)

    // Geoform 1 paper-day: cool ambient + warm key + cool fill. No HDRI, no bloom.
    this.scene.add(new THREE.AmbientLight(0x9ab0c8, 0.48))
    this.sun = new THREE.DirectionalLight(0xfff6e8, 1.45)
    this.sun.target.position.set(0, 0, 0)
    this.scene.add(this.sun)
    this.scene.add(this.sun.target)
    this.fill = new THREE.DirectionalLight(0x88a8d0, 0.35)
    this.fill.position.set(-2.2, 0.4, -1.6)
    this.scene.add(this.fill)
    this.scene.add(this.makeStars())

    this.layout()
    this.applyCamera()
  }

  private makeStars(): THREE.Points {
    const n = 600
    const pos = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1
      const t = Math.random() * Math.PI * 2
      const r = 8 + Math.random() * 10
      const s = Math.sqrt(Math.max(0, 1 - u * u))
      pos[i * 3] = r * s * Math.cos(t)
      pos[i * 3 + 1] = r * u
      pos[i * 3 + 2] = r * s * Math.sin(t)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    return new THREE.Points(
      g,
      new THREE.PointsMaterial({ color: 0xdde7f4, size: 0.035, sizeAttenuation: true }),
    )
  }

  layout(): void {
    const parent = this.canvas.parentElement
    const w = Math.max(1, parent?.clientWidth ?? this.canvas.clientWidth)
    const h = Math.max(1, parent?.clientHeight ?? this.canvas.clientHeight)
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  sync(world: World, layer: Layer, season: Season, dirtyKey: string): void {
    const { width, height } = world.meta
    const texW = Math.min(TEX_MAX, width * BAKE)
    const colorKey = `${dirtyKey}|${layer}|${season}|${width}x${height}|${texW}|c${world.cities.length}`
    if (colorKey === this.cacheKey && this.colorTex) return
    this.cacheKey = colorKey
    this.colorTex?.dispose()

    const bakeScale = Math.max(2, Math.round(texW / width))
    this.colorTex = imageDataToTexture(
      bakeWorldImageDataSmooth(world, season, layer, texW, {
        showRivers: layer === 'relief' || layer === 'biome',
        bakeCities: true,
        vignette: false,
      }),
      this.renderer,
      { srgb: true },
    )

    const terrainKey = `${width}x${height}|${texW}|${world.meta.seed}|${world.cities.length}|e${world.elev[0]}:${world.elev[world.elev.length >> 1]}`
    if (terrainKey !== this.terrainKey || !this.bumpTex) {
      this.terrainKey = terrainKey
      this.bumpTex?.dispose()
      this.normalTex?.dispose()
      this.dispTex?.dispose()
      this.roughTex?.dispose()
      this.bumpTex = imageDataToTexture(bakeBumpImageData(world, bakeScale), this.renderer)
      this.normalTex = imageDataToTexture(bakeNormalImageData(world, bakeScale), this.renderer)
      this.dispTex = imageDataToTexture(bakeDisplacementImageData(world, bakeScale), this.renderer, {
        mipmaps: false,
      })
      this.roughTex = imageDataToTexture(bakeRoughnessImageData(world, bakeScale), this.renderer)
    }

    const mat = this.globe.material as THREE.MeshStandardMaterial
    mat.map = this.colorTex
    mat.bumpMap = this.bumpTex
    mat.bumpScale = 0.055
    mat.normalMap = this.normalTex
    mat.normalScale = new THREE.Vector2(1.2, 1.2)
    mat.displacementMap = this.dispTex
    mat.displacementScale = DISPLACE
    mat.roughnessMap = this.roughTex
    mat.roughness = 1
    mat.metalness = 0.04
    mat.needsUpdate = true
  }

  orbit(dx: number, dy: number): void {
    this.yaw -= dx * 0.0055
    this.pitch = Math.max(-1.15, Math.min(1.15, this.pitch + dy * 0.0045))
    this.applyCamera()
  }

  dolly(factor: number): void {
    this.distance = Math.max(1.45, Math.min(6.2, this.distance * factor))
    this.applyCamera()
  }

  reset(): void {
    this.yaw = 0.85
    this.pitch = 0.22
    this.distance = 3.15
    this.applyCamera()
  }

  private applyCamera(): void {
    const cp = Math.cos(this.pitch)
    this.camera.position.set(
      this.distance * cp * Math.sin(this.yaw),
      this.distance * Math.sin(this.pitch),
      this.distance * cp * Math.cos(this.yaw),
    )
    this.camera.lookAt(0, 0, 0)
    this.sun.position.copy(this.camera.position).add(new THREE.Vector3(1.4, 0.8, 0.6))
  }

  pick(clientX: number, clientY: number, world: World): { x: number; y: number } | null {
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return null
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    )
    const ray = new THREE.Raycaster()
    ray.setFromCamera(ndc, this.camera)
    const hits = ray.intersectObject(this.globe)
    const hit = hits[0]
    if (!hit?.uv) return null
    const x = Math.min(world.meta.width - 1, Math.max(0, Math.floor(hit.uv.x * world.meta.width)))
    const y = Math.min(
      world.meta.height - 1,
      Math.max(0, Math.floor((1 - hit.uv.y) * world.meta.height)),
    )
    return { x, y }
  }

  onPointerDown(clientX: number, clientY: number): void {
    this.dragging = true
    this.lastX = clientX
    this.lastY = clientY
  }

  onPointerMove(clientX: number, clientY: number): boolean {
    if (!this.dragging) return false
    this.orbit(clientX - this.lastX, clientY - this.lastY)
    this.lastX = clientX
    this.lastY = clientY
    return true
  }

  onPointerUp(): void {
    this.dragging = false
  }

  render(): void {
    this.renderer.render(this.scene, this.camera)
  }

  dispose(): void {
    this.colorTex?.dispose()
    this.bumpTex?.dispose()
    this.normalTex?.dispose()
    this.dispTex?.dispose()
    this.roughTex?.dispose()
    this.globe.geometry.dispose()
    ;(this.globe.material as THREE.MeshStandardMaterial).dispose()
    this.atmosphere.geometry.dispose()
    ;(this.atmosphere.material as THREE.Material).dispose()
    this.renderer.dispose()
  }
}
