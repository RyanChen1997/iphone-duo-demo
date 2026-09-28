import * as THREE from 'three';

const WIDTH = 3.18;
const HEIGHT = 4.38;
const RADIUS = 0.34;
const SCREEN_WIDTH = WIDTH - .105;
const SCREEN_HEIGHT = HEIGHT - .18;
const SCREEN_RADIUS = RADIUS - .08;
const WALLPAPER_WIDTH = 1600;
const WALLPAPER_HEIGHT = 1100;

function roundedRect(width: number, height: number, radius: number, edge: 'left' | 'right' | 'all' = 'all') {
  const x = -width / 2;
  const y = -height / 2;
  const left = edge === 'right' ? .015 : radius;
  const right = edge === 'left' ? .015 : radius;
  const shape = new THREE.Shape();
  shape.moveTo(x + left, y);
  shape.lineTo(x + width - right, y);
  shape.quadraticCurveTo(x + width, y, x + width, y + right);
  shape.lineTo(x + width, y + height - right);
  shape.quadraticCurveTo(x + width, y + height, x + width - right, y + height);
  shape.lineTo(x + left, y + height);
  shape.quadraticCurveTo(x, y + height, x, y + height - left);
  shape.lineTo(x, y + left);
  shape.quadraticCurveTo(x, y, x + left, y);
  return shape;
}

function frameShape(width: number, height: number, radius: number, side: 'left' | 'right') {
  const frame = roundedRect(width, height, radius, side);
  const opening = roundedRect(width - .19, height - .19, radius - .095, side);
  frame.holes.push(new THREE.Path(opening.getPoints(16).reverse()));
  return frame;
}

function screenGeometry(width: number, height: number, radius: number, side: 'left' | 'right' | 'cover') {
  const geometry = new THREE.ShapeGeometry(roundedRect(width, height, radius, side === 'cover' ? 'left' : side), 16);
  const position = geometry.getAttribute('position');
  const uvs = geometry.getAttribute('uv');
  // A portrait cover displays a centered crop of the landscape wallpaper.
  // Sampling all 0..1 here would squeeze the entire image into half the width.
  const coverFraction = Math.min(1, (width / height) * (WALLPAPER_HEIGHT / WALLPAPER_WIDTH));
  for (let i = 0; i < position.count; i++) {
    const u = position.getX(i) / width + 0.5;
    const v = position.getY(i) / height + 0.5;
    const imageU = side === 'left' ? u * .5 : side === 'right' ? .5 + u * .5 : .5 + (u - .5) * coverFraction;
    uvs.setXY(i, imageU, v);
  }
  return geometry;
}

// The left leaf is glass in front of a stationary image plane. Sample the
// wallpaper where the camera ray through each glass pixel meets that plane,
// instead of carrying the image's UVs around with the rotating leaf.
function projectedWallpaperMaterial(
  sharp: THREE.CanvasTexture,
  soft: THREE.CanvasTexture,
  blurred: THREE.CanvasTexture,
  outside = false,
) {
  return new THREE.ShaderMaterial({
    uniforms: {
      sharpMap: { value: sharp },
      softMap: { value: soft },
      blurredMap: { value: blurred },
      fold: { value: 0 },
      coverAmount: { value: 0 },
      wallpaperOffset: { value: 0 },
    },
    vertexShader: `
      varying vec3 vWorldPosition;
      varying float vGlassX;
      varying vec2 vCoverUv;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        vGlassX = position.x / ${SCREEN_WIDTH} + 0.5;
        vCoverUv = uv;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      uniform sampler2D sharpMap;
      uniform sampler2D softMap;
      uniform sampler2D blurredMap;
      uniform float fold;
      uniform float coverAmount;
      uniform float wallpaperOffset;
      varying vec3 vWorldPosition;
      varying float vGlassX;
      varying vec2 vCoverUv;
      void main() {
        // The image stays in the right display's plane. Only the silhouette
        // and the optical treatment belong to the moving glass.
        float rayScale = (cameraPosition.z - 0.074) / (cameraPosition.z - vWorldPosition.z);
        vec3 imagePoint = cameraPosition + (vWorldPosition - cameraPosition) * rayScale;
        vec2 uv = vec2(0.5 + (imagePoint.x - wallpaperOffset) / ${2 * SCREEN_WIDTH},
                       0.5 + imagePoint.y / ${SCREEN_HEIGHT});
        // The wallpaper ends at a fixed rectangle. Outside it the glass is
        // black; only the boundary is defocused so there is no horizontal cut
        // between the image and the dark wedges above and below it.
        float overshoot = max(max(-uv.x, uv.x - 1.0), max(-uv.y, uv.y - 1.0));
        float feather = ${outside ? '0.075' : '0.003 + 0.065 * smoothstep(0.0, 0.28, fold)'};
        float imageWeight = smoothstep(-feather * 0.45, feather, -overshoot);
        float outerEdge = clamp(1.0 - vGlassX, 0.0, 1.0);
        float haze = ${outside ? '0.38 * pow(outerEdge, 0.8)' : 'min(1.0, fold * 4.4) * pow(outerEdge, 0.8)'};
        vec3 image = texture2D(sharpMap, uv).rgb;
        image = mix(image, texture2D(softMap, uv).rgb, haze * 0.8);
        image = mix(image, texture2D(blurredMap, uv).rgb, pow(haze, 1.5) * 0.85);
        float shadow = ${outside ? '0.24 * pow(outerEdge, 1.35)' : 'min(1.0, fold * 5.0) * (0.02 + 0.95 * pow(outerEdge, 1.35))'};
        image *= 1.0 - shadow;
        image = mix(vec3(0.002, 0.003, 0.005), image, imageWeight);
        ${outside ? `// At the closed detent the outside display turns on with its own
        // centered portrait crop, replacing the view through the pane.
        image = mix(image, texture2D(sharpMap, vCoverUv).rgb, coverAmount);` : ''}
        gl_FragColor = vec4(image, 1.0);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
    toneMapped: false,
  });
}

function wallpaperCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = WALLPAPER_WIDTH;
  canvas.height = WALLPAPER_HEIGHT;
  return canvas;
}

function overlayGeometry(width: number, height: number, radius: number, side: 'left' | 'right' | 'cover') {
  const geometry = new THREE.ShapeGeometry(roundedRect(width, height, radius, side === 'cover' ? 'left' : side), 16);
  const position = geometry.getAttribute('position');
  const uvs = geometry.getAttribute('uv');
  for (let i = 0; i < position.count; i++) {
    uvs.setXY(i, position.getX(i) / width + .5, position.getY(i) / height + .5);
  }
  return geometry;
}

function rearScreenShadowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  const horizontal = ctx.createLinearGradient(0, 0, 256, 0);
  horizontal.addColorStop(0, 'rgba(3,5,8,.77)');
  horizontal.addColorStop(.25, 'rgba(3,5,8,.25)');
  horizontal.addColorStop(.7, 'rgba(3,5,8,0)');
  horizontal.addColorStop(1, 'rgba(3,5,8,0)');
  ctx.fillStyle = horizontal;
  ctx.fillRect(0, 0, 256, 512);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function glassReflectionTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  const reflection = ctx.createLinearGradient(0, 0, 256, 0);
  reflection.addColorStop(0, 'rgba(205,224,237,.16)');
  reflection.addColorStop(.16, 'rgba(255,255,255,.02)');
  reflection.addColorStop(.50, 'rgba(255,255,255,.03)');
  reflection.addColorStop(.70, 'rgba(237,247,255,.25)');
  reflection.addColorStop(.77, 'rgba(255,255,255,.04)');
  reflection.addColorStop(1, 'rgba(246,250,255,.23)');
  ctx.fillStyle = reflection;
  ctx.fillRect(0, 0, 256, 512);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function drawDefaultWallpaper(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d')!;
  const { width: w, height: h } = canvas;
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#8096a9');
  sky.addColorStop(0.43, '#c2c4be');
  sky.addColorStop(0.72, '#d8c9ac');
  sky.addColorStop(1, '#b49f83');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  const haze = ctx.createRadialGradient(w * 0.76, h * 0.54, 20, w * 0.76, h * 0.54, w * 0.72);
  haze.addColorStop(0, 'rgba(255,239,204,.74)');
  haze.addColorStop(1, 'rgba(255,239,204,0)');
  ctx.fillStyle = haze;
  ctx.fillRect(0, 0, w, h);

  const mountain = (points: number[], color: string) => {
    ctx.beginPath();
    ctx.moveTo(0, h);
    ctx.lineTo(0, points[0] * h);
    for (let i = 1; i < points.length; i++) ctx.lineTo((i / (points.length - 1)) * w, points[i] * h);
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };
  mountain([.60, .57, .61, .53, .56, .49, .51, .45, .48, .47, .52, .49, .53, .55, .52, .58, .57], '#898a80');
  mountain([.69, .64, .67, .58, .62, .56, .60, .53, .57, .51, .57, .56, .59, .55, .61, .66, .64], '#62655f');
  mountain([.73, .67, .71, .62, .65, .60, .66, .59, .65, .61, .66, .60, .64, .68, .63, .72, .70], '#41433d');

  const sand = ctx.createLinearGradient(0, h * .67, w * .7, h);
  sand.addColorStop(0, '#b1a18a');
  sand.addColorStop(.53, '#e5d4af');
  sand.addColorStop(1, '#a68e73');
  ctx.beginPath();
  ctx.moveTo(0, h * .62);
  ctx.bezierCurveTo(w * .2, h * .67, w * .31, h * .85, w * .49, h * .79);
  ctx.bezierCurveTo(w * .72, h * .86, w * .82, h * .69, w, h * .65);
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.fillStyle = sand;
  ctx.fill();

  const foreground = ctx.createLinearGradient(w * .12, h * .75, w * .92, h * 1.12);
  foreground.addColorStop(0, '#aa9980');
  foreground.addColorStop(.47, '#d2bea0');
  foreground.addColorStop(.72, '#f0ddba');
  foreground.addColorStop(1, '#b9a487');
  ctx.beginPath();
  ctx.moveTo(0, h * .82);
  ctx.bezierCurveTo(w * .28, h * .9, w * .45, h * 1.06, w * .64, h * .95);
  ctx.bezierCurveTo(w * .84, h * .82, w * .91, h * .80, w, h * .78);
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.fillStyle = foreground;
  ctx.fill();
}

export class FoldPhone {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera();
  readonly renderer: THREE.WebGLRenderer;
  private readonly leftPivot = new THREE.Group();
  private readonly model = new THREE.Group();
  private innerCamera?: THREE.Mesh;
  private readonly wallpaper = wallpaperCanvas();
  private readonly blurredWallpaper = wallpaperCanvas();
  private readonly softlyBlurredWallpaper = wallpaperCanvas();
  private readonly texture: THREE.CanvasTexture;
  private readonly blurredTexture: THREE.CanvasTexture;
  private readonly softBlurTexture: THREE.CanvasTexture;
  private readonly leftImageMaterial: THREE.ShaderMaterial;
  private readonly coverGlassMaterial: THREE.ShaderMaterial;
  private readonly rightShadeMaterial: THREE.MeshBasicMaterial;
  private readonly rightVeilMaterial: THREE.MeshBasicMaterial;
  private readonly glassReflectionMaterial: THREE.MeshBasicMaterial;
  private readonly reflectionTexture = glassReflectionTexture();
  private readonly bridgeMaterial: THREE.MeshBasicMaterial;
  private readonly rightShadeTexture = rearScreenShadowTexture();
  private readonly observer: ResizeObserver;
  private readonly container: HTMLElement;
  private readonly imageMaterial: THREE.MeshBasicMaterial;
  private progress = 1;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.65;
    this.renderer.domElement.setAttribute('aria-hidden', 'true');
    container.appendChild(this.renderer.domElement);

    drawDefaultWallpaper(this.wallpaper);
    this.refreshBlurredWallpaper();
    this.texture = new THREE.CanvasTexture(this.wallpaper);
    this.blurredTexture = new THREE.CanvasTexture(this.blurredWallpaper);
    this.softBlurTexture = new THREE.CanvasTexture(this.softlyBlurredWallpaper);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.blurredTexture.colorSpace = THREE.SRGBColorSpace;
    this.softBlurTexture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = Math.min(this.renderer.capabilities.getMaxAnisotropy(), 8);
    this.imageMaterial = new THREE.MeshBasicMaterial({ map: this.texture, side: THREE.DoubleSide, toneMapped: false });
    this.leftImageMaterial = projectedWallpaperMaterial(this.texture, this.softBlurTexture, this.blurredTexture);
    this.coverGlassMaterial = projectedWallpaperMaterial(this.texture, this.softBlurTexture, this.blurredTexture, true);
    this.rightShadeMaterial = new THREE.MeshBasicMaterial({ map: this.rightShadeTexture, transparent: true, opacity: 0, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
    this.rightVeilMaterial = new THREE.MeshBasicMaterial({ color: '#090c12', transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
    this.glassReflectionMaterial = new THREE.MeshBasicMaterial({ map: this.reflectionTexture, transparent: true, opacity: 0, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
    this.bridgeMaterial = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, opacity: 1, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });

    this.scene.add(new THREE.AmbientLight('#ffffff', 2.7));
    const key = new THREE.DirectionalLight('#ffffff', 3.1);
    key.position.set(-4, 6, 9);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight('#c4d0da', 2);
    rim.position.set(5, -2, -4);
    this.scene.add(rim);
    this.scene.add(this.model);
    this.buildPhone();
    this.camera.position.set(0, 0, 14);
    this.camera.lookAt(0, 0, 0);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();
  }

  private refreshBlurredWallpaper() {
    const blurInto = (target: HTMLCanvasElement, radius: number) => {
      const ctx = target.getContext('2d')!;
      const { width, height } = target;
      ctx.clearRect(0, 0, width, height);
      // Extend pixels beyond the edges so Gaussian blur has no transparent rim.
      ctx.filter = `blur(${radius}px)`;
      ctx.drawImage(this.wallpaper, -radius * 1.5, -radius * 1.5, width + radius * 3, height + radius * 3);
      ctx.filter = 'none';
    };
    blurInto(this.softlyBlurredWallpaper, 20);
    blurInto(this.blurredWallpaper, 52);
  }

  private buildPhone() {
    const metal = new THREE.MeshPhysicalMaterial({ color: '#35393c', metalness: 0.83, roughness: 0.24, clearcoat: 0.75, clearcoatRoughness: 0.18 });
    const blackGlass = new THREE.MeshPhysicalMaterial({ color: '#090b0c', metalness: 0.22, roughness: 0.13, clearcoat: 1, clearcoatRoughness: 0.08 });
    const seam = new THREE.MeshStandardMaterial({ color: '#777b7b', metalness: 0.9, roughness: 0.25 });

    const panel = (side: 'left' | 'right') => {
      const group = new THREE.Group();
      const shell = new THREE.Mesh(new THREE.ExtrudeGeometry(side === 'left' ? frameShape(WIDTH, HEIGHT, RADIUS, side) : roundedRect(WIDTH, HEIGHT, RADIUS, side), {
        depth: .115, bevelEnabled: true, bevelThickness: .025, bevelSize: .025, bevelSegments: 3, curveSegments: 16,
      }), metal);
      shell.position.z = -.075;
      group.add(shell);

      const faceShape = side === 'left' ? frameShape(WIDTH - .085, HEIGHT - .085, RADIUS - .04, side) : roundedRect(WIDTH - .085, HEIGHT - .085, RADIUS - .04, side);
      const face = new THREE.Mesh(new THREE.ShapeGeometry(faceShape, 16), blackGlass);
      face.position.z = .068;
      group.add(face);
      // Extend each image to the hinge. Both textures sample adjacent halves of
      // the same source image, so they meet without a black bezel in the middle.
      const screenX = side === 'left' ? .0525 : -.0525;
      const display = new THREE.Mesh(screenGeometry(SCREEN_WIDTH, SCREEN_HEIGHT, SCREEN_RADIUS, side), side === 'left' ? this.leftImageMaterial : this.imageMaterial);
      display.position.set(screenX, 0, .074);
      group.add(display);

      if (side === 'left') {
        const reflection = new THREE.Mesh(overlayGeometry(SCREEN_WIDTH, SCREEN_HEIGHT, SCREEN_RADIUS, side), this.glassReflectionMaterial);
        reflection.position.set(screenX, 0, .087);
        group.add(reflection);
      } else {
        const shade = new THREE.Mesh(overlayGeometry(SCREEN_WIDTH, SCREEN_HEIGHT, SCREEN_RADIUS, side), this.rightShadeMaterial);
        shade.position.set(screenX, 0, .079);
        group.add(shade);
        const veil = new THREE.Mesh(overlayGeometry(SCREEN_WIDTH, SCREEN_HEIGHT, SCREEN_RADIUS, side), this.rightVeilMaterial);
        veil.position.set(screenX, 0, .081);
        group.add(veil);
      }

      const backShape = side === 'left' ? frameShape(WIDTH - .09, HEIGHT - .09, RADIUS - .04, side) : roundedRect(WIDTH - .09, HEIGHT - .09, RADIUS - .04, side);
      const backside = new THREE.Mesh(new THREE.ShapeGeometry(backShape, 16), blackGlass);
      backside.rotation.y = Math.PI;
      backside.position.z = -.092;
      group.add(backside);

      if (side === 'left') {
        // After edge-on the rear of the same hollow glass pane faces the
        // camera. It samples the stationary wallpaper until the cover display
        // lights up near the fully closed position.
        const cover = new THREE.Mesh(screenGeometry(SCREEN_WIDTH, SCREEN_HEIGHT, SCREEN_RADIUS, 'cover'), this.coverGlassMaterial);
        cover.rotation.y = Math.PI;
        cover.position.set(.0525, 0, -.094);
        group.add(cover);
        const reflection = new THREE.Mesh(overlayGeometry(SCREEN_WIDTH, SCREEN_HEIGHT, SCREEN_RADIUS, 'cover'), this.glassReflectionMaterial);
        reflection.rotation.y = Math.PI;
        reflection.position.set(.0525, 0, -.098);
        group.add(reflection);
        const sensor = new THREE.Mesh(new THREE.CircleGeometry(.045, 24), blackGlass);
        sensor.rotation.y = Math.PI;
        sensor.position.set(-1.03, 1.88, -.12);
        group.add(sensor);
      }

      if (side === 'right') {
        const camera = new THREE.Mesh(new THREE.CircleGeometry(.045, 24), blackGlass);
        camera.position.set(-.18, 1.9, .083);
        this.innerCamera = camera;
        group.add(camera);
        for (const y of [.95, .65]) {
          const button = new THREE.Mesh(new THREE.BoxGeometry(.045, .22, .073), seam);
          button.position.set(WIDTH / 2 + .035, y, -.006);
          group.add(button);
        }
      }
      return group;
    };

    const right = panel('right');
    right.position.x = WIDTH / 2;
    this.model.add(right);

    const left = panel('left');
    left.position.x = -WIDTH / 2;
    this.leftPivot.add(left);
    this.model.add(this.leftPivot);

    // At the fully-open detent, a narrow sampled strip conceals the physical
    // hinge and antialiased edge pixels. It fades out as the fold begins.
    const bridgeGeometry = new THREE.PlaneGeometry(.105, SCREEN_HEIGHT);
    const uv = bridgeGeometry.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setX(i, .5 + (uv.getX(i) - .5) * .105 / (WIDTH * 2));
    const bridge = new THREE.Mesh(bridgeGeometry, this.bridgeMaterial);
    bridge.position.z = .09;
    bridge.renderOrder = 4;
    this.model.add(bridge);

    const hinge = new THREE.Mesh(new THREE.CylinderGeometry(.045, .045, HEIGHT - .12, 24), metal);
    hinge.position.z = -.06;
    this.model.add(hinge);
    const spine = new THREE.Mesh(new THREE.CylinderGeometry(.017, .017, HEIGHT - .22, 16), seam);
    spine.position.z = .057;
    this.model.add(spine);
  }

  private resize() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (!width || !height) return;
    this.renderer.setSize(width, height);
    FoldPhone.frameCamera(this.camera, width / height);
    this.render();
  }

  static frameCamera(camera: THREE.PerspectiveCamera, aspect: number) {
    const viewHeight = Math.max(5.4, 7.5 / aspect);
    camera.aspect = aspect;
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(viewHeight / 28));
    camera.near = .1;
    camera.far = 50;
    camera.updateProjectionMatrix();
  }

  setFold(progress: number) {
    this.progress = Math.max(0, Math.min(1, progress));
    const fold = 1 - this.progress;
    // One uninterrupted 180-degree arc: first the inner screen turns edge-on,
    // then the outside surface travels slowly across the stationary screen.
    const angle = fold * Math.PI;
    this.leftPivot.rotation.y = angle;
    // Only the turning pane gets defocus and shadow; the wallpaper on the
    // stationary right display does not fade out as the hinge moves.
    this.leftImageMaterial.uniforms.fold.value = fold;
    this.glassReflectionMaterial.opacity = Math.min(1, fold * 2.3);
    this.rightShadeMaterial.opacity = fold * .12;
    const edgeDistance = (angle - Math.PI / 2) / .43;
    this.rightVeilMaterial.opacity = .10 * Math.exp(-edgeDistance * edgeDistance);
    // A separate portrait cover image appears only near the closed detent.
    const coverTransition = THREE.MathUtils.clamp((.16 - this.progress) / .16, 0, 1);
    this.coverGlassMaterial.uniforms.coverAmount.value = coverTransition * coverTransition * (3 - 2 * coverTransition);
    // The inner punch-hole is concealed once the outside glass covers it.
    if (this.innerCamera) this.innerCamera.visible = this.progress > .18;
    this.bridgeMaterial.opacity = Math.min(1, Math.max(0, (this.progress - .95) / .05));
    // Center the actual perspective silhouette, not just its 3D coordinates.
    // Smooth its translation to a stop at 90°, then hold the rear leaf still.
    const halfTurn = Math.min(angle, Math.PI / 2);
    const projectedCenter = (a: number) =>
      WIDTH * (14 * Math.cos(a) - 14 + WIDTH * Math.sin(a)) / (28 - WIDTH * Math.sin(a));
    const brakingAngle = 75 * Math.PI / 180;
    if (halfTurn <= brakingAngle) {
      this.model.position.x = projectedCenter(halfTurn);
    } else {
      const span = Math.PI / 2 - brakingAngle;
      const t = (halfTurn - brakingAngle) / span;
      const t2 = t * t;
      const t3 = t2 * t;
      const start = projectedCenter(brakingAngle);
      const slope = (projectedCenter(brakingAngle + .001) - projectedCenter(brakingAngle - .001)) / .002;
      const end = projectedCenter(Math.PI / 2);
      this.model.position.x = (2 * t3 - 3 * t2 + 1) * start + (t3 - 2 * t2 + t) * span * slope + (-2 * t3 + 3 * t2) * end;
    }
    this.leftImageMaterial.uniforms.wallpaperOffset.value = this.model.position.x;
    this.coverGlassMaterial.uniforms.wallpaperOffset.value = this.model.position.x;
    this.render();
  }

  setImage(image: HTMLImageElement) {
    const ctx = this.wallpaper.getContext('2d')!;
    const w = this.wallpaper.width;
    const h = this.wallpaper.height;
    ctx.clearRect(0, 0, w, h);
    const scale = Math.max(w / image.naturalWidth, h / image.naturalHeight);
    const iw = image.naturalWidth * scale;
    const ih = image.naturalHeight * scale;
    ctx.drawImage(image, (w - iw) / 2, (h - ih) / 2, iw, ih);
    this.refreshBlurredWallpaper();
    this.texture.needsUpdate = true;
    this.blurredTexture.needsUpdate = true;
    this.softBlurTexture.needsUpdate = true;
    this.render();
  }

  resetImage() {
    drawDefaultWallpaper(this.wallpaper);
    this.refreshBlurredWallpaper();
    this.texture.needsUpdate = true;
    this.blurredTexture.needsUpdate = true;
    this.softBlurTexture.needsUpdate = true;
    this.render();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  getFold() { return this.progress; }

  dispose() {
    this.observer.disconnect();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.texture.dispose();
    this.blurredTexture.dispose();
    this.softBlurTexture.dispose();
    this.reflectionTexture.dispose();
    this.rightShadeTexture.dispose();
    const materials = new Set<THREE.Material>();
    this.scene.traverse(object => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        const meshMaterials = Array.isArray(object.material) ? object.material : [object.material];
        meshMaterials.forEach(material => materials.add(material));
      }
    });
    materials.forEach(material => material.dispose());
  }
}
