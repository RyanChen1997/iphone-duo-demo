import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowCounterClockwise, ArrowDown, Check, DownloadSimple, ImageSquare,
  Pause, Play, UploadSimple,
} from '@phosphor-icons/react';
import * as THREE from 'three';
import { FoldPhone } from './phone';
import './style.css';

const GIF_WIDTH = 640;
const GIF_HEIGHT = 440;
const GIF_FRAMES = 72;

function App() {
  const stageRef = useRef<HTMLDivElement>(null);
  const phoneRef = useRef<FoldPhone | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  const percentRef = useRef<HTMLSpanElement>(null);
  const stateRef = useRef<HTMLSpanElement>(null);
  const animationRef = useRef<number | null>(null);
  const progressRef = useRef(1);
  const imageUrlRef = useRef<string | null>(null);
  const [fileName, setFileName] = useState('沙丘 · 默认画面');
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportPercent, setExportPercent] = useState(0);
  const [message, setMessage] = useState('');
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!stageRef.current) return;
    const phone = new FoldPhone(stageRef.current);
    phoneRef.current = phone;
    return () => {
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
      phone.dispose();
      phoneRef.current = null;
    };
  }, []);

  function updateFold(value: number) {
    const progress = Math.max(0, Math.min(1, value));
    progressRef.current = progress;
    phoneRef.current?.setFold(progress);
    if (sliderRef.current) {
      sliderRef.current.value = String(progress);
      sliderRef.current.style.setProperty('--value', `${progress * 100}%`);
    }
    if (percentRef.current) percentRef.current.textContent = `${Math.round(progress * 100)}%`;
    if (stateRef.current) stateRef.current.textContent = progress < .08 ? '已合上' : progress > .92 ? '已展开' : '折叠中';
  }

  function stopPlayback() {
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
    setPlaying(false);
  }

  function playCycle() {
    if (playing) { stopPlayback(); return; }
    const start = performance.now();
    setPlaying(true);
    const tick = (now: number) => {
      const t = Math.min((now - start) / 3000, 1);
      // One complete open → closed → open cycle.
      updateFold((1 + Math.cos(t * Math.PI * 2)) / 2);
      if (t < 1) animationRef.current = requestAnimationFrame(tick);
      else { animationRef.current = null; setPlaying(false); }
    };
    animationRef.current = requestAnimationFrame(tick);
  }

  async function loadFile(file?: File) {
    if (!file) return;
    if (!file.type.startsWith('image/')) { setMessage('请选择 PNG、JPG、WebP 等图片文件。'); return; }
    if (file.size > 20 * 1024 * 1024) { setMessage('图片不能超过 20 MB。'); return; }
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      stopPlayback();
      phoneRef.current?.setImage(image);
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
      imageUrlRef.current = url;
      setThumbnail(url);
      setFileName(file.name);
      setMessage('图片已放入屏幕。拖动滑杆查看效果。');
      if (inputRef.current) inputRef.current.value = '';
    };
    image.onerror = () => { URL.revokeObjectURL(url); setMessage('无法读取这张图片，请换一张试试。'); };
    image.src = url;
  }

  function resetImage() {
    phoneRef.current?.resetImage();
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    imageUrlRef.current = null;
    setThumbnail(null);
    setFileName('沙丘 · 默认画面');
    setMessage('已恢复默认画面。');
  }

  async function exportGif() {
    const phone = phoneRef.current;
    if (!phone || exporting) return;
    stopPlayback();
    setExporting(true);
    setExportPercent(0);
    setMessage('正在制作 GIF，请稍候…');
    const originalFold = progressRef.current;
    let exportRenderer: THREE.WebGLRenderer | null = null;
    try {
      const { GIFEncoder, quantize, applyPalette } = await import('gifenc');
      exportRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      exportRenderer.setPixelRatio(1);
      exportRenderer.setSize(GIF_WIDTH, GIF_HEIGHT);
      exportRenderer.outputColorSpace = THREE.SRGBColorSpace;
      exportRenderer.toneMapping = THREE.ACESFilmicToneMapping;
      exportRenderer.toneMappingExposure = 1.65;
      exportRenderer.setClearColor(0x000000, 0);
      const camera = phone.camera.clone();
      FoldPhone.frameCamera(camera, GIF_WIDTH / GIF_HEIGHT);
      const canvas = document.createElement('canvas');
      canvas.width = GIF_WIDTH;
      canvas.height = GIF_HEIGHT;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('Canvas is unavailable');
      const gif = GIFEncoder();
      for (let i = 0; i < GIF_FRAMES; i++) {
        const t = Math.max(0, Math.min(1, (i - 4) / (GIF_FRAMES - 9)));
        phone.setFold((1 + Math.cos(t * Math.PI * 2)) / 2);
        exportRenderer.render(phone.scene, camera);
        ctx.fillStyle = '#f5f5f7';
        ctx.fillRect(0, 0, GIF_WIDTH, GIF_HEIGHT);
        ctx.drawImage(exportRenderer.domElement, 0, 0);
        const pixels = ctx.getImageData(0, 0, GIF_WIDTH, GIF_HEIGHT).data;
        const palette = quantize(pixels, 192, { format: 'rgb565' });
        const indexed = applyPalette(pixels, palette, 'rgb565');
        gif.writeFrame(indexed, GIF_WIDTH, GIF_HEIGHT, { palette, delay: 60, repeat: 0 });
        if (i % 3 === 0 || i === GIF_FRAMES - 1) {
          setExportPercent(Math.round((i + 1) / GIF_FRAMES * 100));
          await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
      }
      gif.finish();
      const bytes = gif.bytes();
      const copy = new Uint8Array(bytes.length);
      copy.set(bytes);
      const blob = new Blob([copy], { type: 'image/gif' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'fold-studio-open-close-open.gif';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setMessage('GIF 已导出，完整记录展开 → 合上 → 再展开。');
    } catch (error) {
      console.error('GIF export failed:', error);
      setMessage('导出失败，请重试。若设备内存不足，请关闭其他标签页。');
    } finally {
      exportRenderer?.dispose();
      phone.setFold(originalFold);
      setExporting(false);
    }
  }

  return (
    <div className="page-shell">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Fold Studio 首页">
          <span className="brand-mark" aria-hidden="true"><i /><i /></span>
          <span>fold<span className="brand-light">studio</span><span className="brand-dot">.</span></span>
        </a>
        <div className="header-right"><span className="header-live"><span className="live-dot" /> 交互预览</span><span className="header-divider" /><span>YOUR IMAGE, IN MOTION</span></div>
      </header>

      <main id="top">
        <div className="intro">
          <div className="eyebrow"><span className="eyebrow-line" /> A NEW PERSPECTIVE</div>
          <h1>把画面，<span>展开。</span></h1>
          <p>放入你的图片，亲手体验从展开到合上的每一个角度。</p>
        </div>

        <div className="experience">
          <div
            className={`phone-area${dragging ? ' is-dragging' : ''}`}
            onDragOver={event => { event.preventDefault(); setDragging(true); }}
            onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
            onDrop={event => { event.preventDefault(); setDragging(false); void loadFile(event.dataTransfer.files[0]); }}
          >
            <div className="stage-topline"><span><span className="crosshair">✳</span> 实时渲染</span></div>
            <div className="phone-glow" aria-hidden="true" />
            <div className="phone-stage" ref={stageRef} role="img" aria-label="可交互的折叠屏手机模型，屏幕显示当前图片" />
            <div className="stage-bottomline"><span ref={stateRef}>已展开</span><span className="stage-rule" /><span ref={percentRef}>100%</span></div>
            {dragging && <div className="drop-overlay"><UploadSimple size={30} weight="light" /> 松开以放入屏幕</div>}
          </div>

          <div className="control-panel">
            <div className="control-header"><div><span className="control-index">折叠角度</span><h2>开合之间，由你决定。</h2></div><button className="play-button" type="button" onClick={playCycle} disabled={exporting} aria-label={playing ? '暂停动画' : '播放完整动画'}>{playing ? <Pause size={18} weight="fill" /> : <Play size={18} weight="fill" />}{playing ? '暂停' : '播放动画'}</button></div>
            <div className="slider-row"><span className="slider-end">合上</span><div className="slider-wrap"><input ref={sliderRef} className="fold-slider" type="range" min="0" max="1" step="0.001" defaultValue="1" style={{ '--value': '100%' } as React.CSSProperties} onPointerDown={stopPlayback} onInput={event => updateFold(Number(event.currentTarget.value))} aria-label="控制折叠屏的展开角度" /><span className="slider-tick slider-tick-start" /><span className="slider-tick slider-tick-middle" /><span className="slider-tick slider-tick-end" /></div><span className="slider-end">展开</span></div>
            <p className="slider-caption">拖动滑杆，体验完整的开合过程。<span>实时预览</span></p>
          </div>
        </div>

        <div className="bottom-bar">
          <div className="image-info"><span className={`image-thumb${thumbnail ? ' uploaded' : ''}`} style={thumbnail ? { backgroundImage: `url("${thumbnail}")` } : undefined}><ImageSquare size={18} weight="light" /></span><div className="image-copy"><span className="image-label">当前屏幕画面</span><strong title={fileName}>{fileName}</strong></div>{thumbnail && <button className="reset-button" type="button" onClick={resetImage} aria-label="恢复默认画面" title="恢复默认画面"><ArrowCounterClockwise size={16} /></button>}</div>
          <div className="action-buttons"><input ref={inputRef} className="sr-only" id="upload-image" type="file" accept="image/*" onChange={event => void loadFile(event.target.files?.[0])} /><button className="secondary-button" type="button" onClick={() => inputRef.current?.click()} disabled={exporting}><UploadSimple size={18} weight="regular" /> 上传图片</button><button className="primary-button" type="button" onClick={() => void exportGif()} disabled={exporting}>{exporting ? <span className="button-progress">{exportPercent}%</span> : <DownloadSimple size={18} weight="regular" />}{exporting ? '正在生成 GIF' : '导出 GIF'}<ArrowDown className="button-arrow" size={15} /></button></div>
        </div>
        <div className="feedback" role="status" aria-live="polite">{message ? <><Check size={15} weight="bold" /> {message}</> : <>支持 PNG、JPG、WebP · 图片仅在你的浏览器中处理 · GIF 包含完整开合循环</>}</div>
      </main>
      <footer><span>FOLD STUDIO / INTERACTIVE STUDY</span><span>灵感来自折叠屏形态 · 非 Apple 官方网站</span></footer>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
