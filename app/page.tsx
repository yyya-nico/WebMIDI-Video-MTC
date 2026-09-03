'use client';

import { ChangeEvent, DragEvent, useCallback, useEffect, useRef, useState } from 'react';

type MidiInputLike = { id: string; name?: string; onmidimessage: ((event: { data?: Uint8Array }) => void) | null };
type MidiAccessLike = { inputs: Map<string, MidiInputLike>; onstatechange: (() => void) | null };
type DecodedMtc = { hours: number; minutes: number; seconds: number; frames: number; fps: number; dropFrame: boolean; direction: 'forward' | 'reverse' };

const FRAME_RATES = [24, 25, 29.97, 30] as const;
const ACCEPTED_VIDEO_TYPES = 'video/*,.mp4,.mov,.m4v,.webm';
const VIDEO_SYNC_INTERVAL_MS = 1000;

function formatTimecode(value: DecodedMtc | null) {
  if (!value) return '00:00:00:00';
  return [value.hours, value.minutes, value.seconds, value.frames].map((part) => part.toString().padStart(2, '0')).join(':');
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds)) return '--:--';
  const mins = Math.floor(seconds / 60);
  return `${mins}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
}

function mtcToSeconds(value: DecodedMtc) {
  return value.hours * 3600 + value.minutes * 60 + value.seconds + value.frames / value.fps;
}

function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const midiAccessRef = useRef<MidiAccessLike | null>(null);
  const midiInputRef = useRef<MidiInputLike | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const quarterFramesRef = useRef(new Uint8Array(8));
  const receivedPartsRef = useRef(0);
  const previousPartRef = useRef<number | null>(null);
  const lastPacketAtRef = useRef(0);
  const lastVideoSyncAtRef = useRef<number | null>(null);
  const syncEnabledRef = useRef(false);
  const offsetRef = useRef(0);

  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [fileSize, setFileSize] = useState('');
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [midiInputs, setMidiInputs] = useState<MidiInputLike[]>([]);
  const [selectedMidiId, setSelectedMidiId] = useState('');
  const [midiStatus, setMidiStatus] = useState<'waiting' | 'live' | 'error'>('waiting');
  const [statusMessage, setStatusMessage] = useState('MTC信号を待っています');
  const [timecode, setTimecode] = useState<DecodedMtc | null>(null);
  const [offset, setOffset] = useState(0);
  const [syncEnabled, setSyncEnabled] = useState(false);

  const disconnectMidi = useCallback(() => {
    if (midiInputRef.current) midiInputRef.current.onmidimessage = null;
    midiInputRef.current = null;
    receivedPartsRef.current = 0;
    previousPartRef.current = null;
    lastVideoSyncAtRef.current = null;
  }, []);

  const syncVideo = useCallback((decoded: DecodedMtc, force = false) => {
    const video = videoRef.current;
    if (!video || !syncEnabledRef.current || video.readyState < 1) return;
    const now = performance.now();
    const lastSyncAt = lastVideoSyncAtRef.current;
    if (!force && lastSyncAt !== null && now - lastSyncAt < VIDEO_SYNC_INTERVAL_MS) return;
    lastVideoSyncAtRef.current = now;

    const quarterFrameCompensation = decoded.direction === 'forward' ? 2 / decoded.fps : 0;
    const correctedTime = mtcToSeconds(decoded) + quarterFrameCompensation + offsetRef.current / 1000;
    if (correctedTime < 0) {
      video.pause();
      video.playbackRate = 1;
      video.currentTime = 0;
      return;
    }
    if (Number.isFinite(video.duration) && correctedTime > video.duration) {
      video.pause();
      video.playbackRate = 1;
      video.currentTime = video.duration;
      return;
    }

    const target = clamp(correctedTime, 0, video.duration || Infinity);
    const drift = target - video.currentTime;
    if (decoded.direction === 'reverse') {
      video.pause();
      video.currentTime = target;
      return;
    }
    if (Math.abs(drift) > 0.09) video.currentTime = target;
    video.playbackRate = clamp(1 + drift * 0.18, 0.97, 1.03);
    if (video.paused) void video.play().catch(() => setStatusMessage('動画を一度クリックして再生を許可してください'));
  }, []);

  const handleMidiMessage = useCallback((event: { data?: Uint8Array }) => {
    const data = event.data;
    if (!data || data.length < 2 || data[0] !== 0xf1) return;
    const part = (data[1] >> 4) & 0x07;
    const previous = previousPartRef.current;
    const completesForward = part === 7 && previous === 6;
    const completesReverse = part === 0 && previous === 1;
    quarterFramesRef.current[part] = data[1] & 0x0f;
    receivedPartsRef.current |= 1 << part;
    previousPartRef.current = part;
    lastPacketAtRef.current = performance.now();
    setMidiStatus('live');
    setStatusMessage('MTC受信中');
    if (receivedPartsRef.current !== 0xff || (!completesForward && !completesReverse)) return;
    const parts = quarterFramesRef.current;
    const rateIndex = (parts[7] >> 1) & 0x03;
    const decoded: DecodedMtc = {
      frames: parts[0] | ((parts[1] & 0x01) << 4),
      seconds: parts[2] | ((parts[3] & 0x03) << 4),
      minutes: parts[4] | ((parts[5] & 0x03) << 4),
      hours: parts[6] | ((parts[7] & 0x01) << 4),
      fps: FRAME_RATES[rateIndex],
      dropFrame: rateIndex === 2,
      direction: completesForward ? 'forward' : 'reverse',
    };
    setTimecode(decoded);
    syncVideo(decoded);
  }, [syncVideo]);

  const selectMidiInput = useCallback((id: string) => {
    disconnectMidi();
    setSelectedMidiId(id);
    const input = midiAccessRef.current?.inputs.get(id) ?? null;
    midiInputRef.current = input;
    if (input) input.onmidimessage = handleMidiMessage;
  }, [disconnectMidi, handleMidiMessage]);

  const refreshMidiInputs = useCallback(() => {
    const inputs = midiAccessRef.current ? [...midiAccessRef.current.inputs.values()] : [];
    setMidiInputs(inputs);
    if (!inputs.length) {
      disconnectMidi();
      setSelectedMidiId('');
      setStatusMessage('MIDI入力が見つかりません');
      return;
    }
    const current = midiInputRef.current?.id;
    selectMidiInput(inputs.some((input) => input.id === current) ? current! : inputs[0].id);
  }, [disconnectMidi, selectMidiInput]);

  useEffect(() => {
    const nav = navigator as Navigator & { requestMIDIAccess?: () => Promise<MidiAccessLike> };
    if (!nav.requestMIDIAccess) {
      setMidiStatus('error');
      setStatusMessage('Web MIDI非対応です。Chrome / Edgeをご利用ください');
      return;
    }
    let active = true;
    void nav.requestMIDIAccess().then((access) => {
      if (!active) return;
      midiAccessRef.current = access;
      access.onstatechange = refreshMidiInputs;
      refreshMidiInputs();
    }).catch(() => {
      setMidiStatus('error');
      setStatusMessage('MIDIアクセスが許可されていません');
    });
    return () => {
      active = false;
      disconnectMidi();
      if (midiAccessRef.current) midiAccessRef.current.onstatechange = null;
    };
  }, [disconnectMidi, refreshMidiInputs]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!lastPacketAtRef.current || performance.now() - lastPacketAtRef.current < 250) return;
      if (midiStatus === 'live') {
        setMidiStatus('waiting');
        setStatusMessage('MTC信号を待っています');
        lastVideoSyncAtRef.current = null;
        const video = videoRef.current;
        if (syncEnabledRef.current && video) { video.pause(); video.playbackRate = 1; }
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, [midiStatus]);

  useEffect(() => () => { if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current); }, []);

  function loadFile(file?: File) {
    if (!file || !file.type.startsWith('video/')) return;
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;
    setVideoUrl(url);
    setFileName(file.name);
    setFileSize(`${(file.size / 1024 / 1024).toFixed(1)} MB`);
    setSyncEnabled(false);
    syncEnabledRef.current = false;
    lastVideoSyncAtRef.current = null;
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    loadFile(event.dataTransfer.files?.[0]);
  }

  function toggleSync() {
    const next = !syncEnabled;
    setSyncEnabled(next);
    syncEnabledRef.current = next;
    lastVideoSyncAtRef.current = null;
    const video = videoRef.current;
    if (!video) return;
    if (!next) { video.pause(); video.playbackRate = 1; }
    else if (timecode) syncVideo(timecode, true);
  }

  function updateOffset(next: number) {
    const safe = clamp(Number.isFinite(next) ? next : 0, -99999, 99999);
    setOffset(safe);
    offsetRef.current = safe;
    if (timecode && syncEnabledRef.current) syncVideo(timecode, true);
  }

  const progress = duration ? (currentTime / duration) * 100 : 0;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span className="brand-name">MTC<span>SYNC</span></span></div>
        <div className={`connection-pill ${midiStatus}`}><span className="status-dot" />{midiStatus === 'live' ? 'MTC CONNECTED' : midiStatus === 'error' ? 'MIDI ERROR' : 'MTC STANDBY'}</div>
      </header>

      <div className="workspace">
        <section className="player-column" aria-label="ビデオプレーヤー">
          <div className={`video-stage ${dragging ? 'is-dragging' : ''} ${videoUrl ? 'has-video' : ''}`} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={handleDrop}>
            {videoUrl ? (
              <video ref={videoRef} src={videoUrl} playsInline onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)} onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} onClick={(event) => { if (!syncEnabled) event.currentTarget.paused ? void event.currentTarget.play() : event.currentTarget.pause(); }} />
            ) : (
              <div className="empty-state">
                <div className="upload-icon" aria-hidden="true"><span>＋</span></div>
                <h1>動画ファイルを選択</h1>
                <p>ここにドラッグ＆ドロップ、またはファイルを参照</p>
                <button className="primary-button" onClick={() => fileInputRef.current?.click()}><span aria-hidden="true">↥</span> ファイルを選ぶ</button>
                <small>MP4 · MOV · WEBM</small>
              </div>
            )}
            {dragging && <div className="drop-overlay">ここにドロップして読み込む</div>}
            {videoUrl && <div className="timecode-overlay"><span>MTC</span><strong>{formatTimecode(timecode)}</strong></div>}
          </div>

          <input ref={fileInputRef} className="sr-only" type="file" accept={ACCEPTED_VIDEO_TYPES} onChange={(event: ChangeEvent<HTMLInputElement>) => loadFile(event.target.files?.[0])} />

          <div className="transport">
            <button className="transport-button" aria-label={syncEnabled ? '同期を解除' : '同期を開始'} disabled={!videoUrl} onClick={toggleSync}>{syncEnabled ? 'Ⅱ' : '▶'}</button>
            <div className="timeline" aria-hidden="true"><span style={{ width: `${progress}%` }} /></div>
            <output>{formatDuration(currentTime)} / {formatDuration(duration)}</output>
            <button className="small-action" onClick={() => fileInputRef.current?.click()} title="動画を変更">↻</button>
          </div>

          <div className="file-strip">
            <div className="file-type">VID</div>
            <div><strong>{fileName || '動画が選択されていません'}</strong><span>{fileName ? `${fileSize} · ブラウザー内のみで処理` : 'ファイルを選ぶと、ここに情報が表示されます'}</span></div>
            {fileName && <button onClick={() => fileInputRef.current?.click()}>変更</button>}
          </div>
        </section>

        <aside className="control-panel" aria-label="同期設定">
          <div className="panel-heading"><p>SYNC CONTROL</p><h2>同期コントロール</h2></div>
          <div className="control-section">
            <label htmlFor="midi-input">MIDI入力</label>
            <div className="select-wrap"><select id="midi-input" value={selectedMidiId} disabled={!midiInputs.length} onChange={(event) => selectMidiInput(event.target.value)}>
              {!midiInputs.length && <option value="">MIDI入力を検索中…</option>}
              {midiInputs.map((input) => <option key={input.id} value={input.id}>{input.name || input.id}</option>)}
            </select></div>
            <p className={`input-status ${midiStatus}`}><span />{statusMessage}</p>
          </div>

          <div className="control-section offset-section">
            <div className="label-row"><label htmlFor="offset">同期オフセット</label><button onClick={() => updateOffset(0)}>リセット</button></div>
            <div className="offset-input"><button aria-label="10ミリ秒戻す" onClick={() => updateOffset(offset - 10)}>−</button><input id="offset" type="number" step="1" value={offset} onChange={(event) => updateOffset(event.target.valueAsNumber)} /><span>ms</span><button aria-label="10ミリ秒進める" onClick={() => updateOffset(offset + 10)}>＋</button></div>
            <p>＋で動画を進め、−で動画を遅らせます</p>
            <div className="nudge-row">{[-100, -10, 10, 100].map((value) => <button key={value} onClick={() => updateOffset(offset + value)}>{value > 0 ? '+' : ''}{value}</button>)}</div>
          </div>

          <div className="timecode-card">
            <div className="card-label"><span>LIVE TIMECODE</span><i className={midiStatus === 'live' ? 'active' : ''} /></div>
            <output>{formatTimecode(timecode)}</output>
            <div className="timecode-meta"><span>{timecode ? `${timecode.fps} FPS${timecode.dropFrame ? ' DF' : ''}` : '-- FPS'}</span><span>{timecode?.direction === 'reverse' ? 'REVERSE' : 'FORWARD'}</span></div>
          </div>

          <button className={`sync-button ${syncEnabled ? 'active' : ''}`} disabled={!videoUrl} onClick={toggleSync}><span>{syncEnabled ? '■' : '▶'}</span>{syncEnabled ? '同期を停止' : 'MTC同期を開始'}</button>
          <p className="privacy-note"><span>●</span> 動画はアップロードされません</p>
        </aside>
      </div>
    </main>
  );
}
