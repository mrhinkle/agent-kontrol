"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DemoBanner } from "@/components/ui";
import { useGibson } from "@/components/use-gibson";
import {
  AgentPanel,
  GibsonTooltip,
  Kbd,
  LegendPanel,
  Roster,
  StatusBanner,
  TowerPanel,
  useTick,
} from "@/components/gibson/hud";
import {
  type GibsonBannerItem,
  type GibsonCameraCommand,
  type GibsonFilters,
  type GibsonFloorStatus,
  type GibsonHoverInfo,
} from "@/lib/gibson-types";

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/** The site header is sticky and can wrap; keep the Gibson flush beneath it. */
function useHeaderHeight(): number {
  const [h, setH] = useState(49);
  useLayoutEffect(() => {
    const header = document.querySelector("body > header");
    if (!(header instanceof HTMLElement)) return;
    const update = () => setH(header.offsetHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(header);
    return () => ro.disconnect();
  }, []);
  return h;
}

function LoadingState() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-[#05070f]">
      <span className="mono animate-pulse text-sm tracking-[0.3em] text-[#19d2ff]">JACKING IN…</span>
    </div>
  );
}

const GibsonScene = dynamic(() => import("@/components/gibson/GibsonScene"), {
  ssr: false,
  loading: () => <LoadingState />,
});

const toolBtn =
  "mono min-h-[30px] min-w-[30px] rounded-md border border-white/15 bg-[#0d1424]/90 px-2.5 text-[11px] text-gray-200 backdrop-blur transition-colors hover:border-white/35 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#19d2ff] disabled:opacity-40";

export default function GibsonPage() {
  const { model, error } = useGibson();
  const headerH = useHeaderHeight();
  const reducedMotion = useReducedMotion();
  useTick();

  const [selectedTowerId, setSelectedTowerId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [selectedOrbId, setSelectedOrbId] = useState<string | null>(null);
  const [hoveredOrbId, setHoveredOrbId] = useState<string | null>(null);
  const [hoverInfo, setHoverInfo] = useState<GibsonHoverInfo | null>(null);
  const [statusFilter, setStatusFilter] = useState<GibsonFloorStatus[]>([]);
  const [platformFilter, setPlatformFilter] = useState<string[]>([]);
  const [autoRotate, setAutoRotate] = useState(false);
  const [cameraCommand, setCameraCommand] = useState<GibsonCameraCommand | null>(null);
  const [panelTab, setPanelTab] = useState<"details" | "key">("key");
  const [keyOpen, setKeyOpen] = useState(false);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  const filters: GibsonFilters | undefined = useMemo(
    () =>
      statusFilter.length === 0 && platformFilter.length === 0
        ? undefined
        : { statuses: statusFilter, platforms: platformFilter },
    [statusFilter, platformFilter],
  );

  const camera = useCallback((kind: GibsonCameraCommand["kind"]) => {
    setCameraCommand((prev) => ({ kind, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  const selectOrb = useCallback((id: string | null, focusRow = false) => {
    setSelectedOrbId(id);
    setSelectedTowerId(null);
    setSelectedTaskId(null);
    setPanelTab(id ? "details" : "key");
    if (id && focusRow) {
      const el = rowRefs.current.get(id);
      el?.focus({ preventScroll: true });
      el?.scrollIntoView({ block: "nearest" });
    }
  }, []);

  const selectTower = useCallback((id: string | null, taskId: number | null = null) => {
    setSelectedTowerId(id);
    setSelectedTaskId(taskId);
    setSelectedOrbId(null);
    setPanelTab(id ? "details" : "key");
  }, []);

  const orbs = model?.orbs;
  const cycle = useCallback(
    (delta: 1 | -1) => {
      if (!orbs || orbs.length === 0) return;
      const i = orbs.findIndex((o) => o.id === selectedOrbId);
      const next = orbs[i === -1 ? (delta === 1 ? 0 : orbs.length - 1) : (i + delta + orbs.length) % orbs.length];
      selectOrb(next.id, true);
    },
    [orbs, selectedOrbId, selectOrb],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); cycle(1); }
      else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); cycle(-1); }
      else if (e.key === "Escape") { selectOrb(null); selectTower(null); }
      else if (e.key === "f" || e.key === "F") camera("fit");
      else if (e.key === "r" || e.key === "R") camera("reset");
      else if (e.key === "+" || e.key === "=") camera("zoom-in");
      else if (e.key === "-" || e.key === "_") camera("zoom-out");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cycle, camera, selectOrb, selectTower]);

  function onBannerItem(key: GibsonBannerItem["key"]) {
    if (!model) return;
    if (key === "failed-agents") {
      const o = model.orbs.find((x) => x.status === "failed");
      if (o) selectOrb(o.id, true);
    } else if (key === "waiting") {
      const o = model.orbs.find((x) => x.status === "waiting");
      if (o) selectOrb(o.id, true);
    } else if (key === "failed-tasks" || key === "review") {
      const status: GibsonFloorStatus = key === "failed-tasks" ? "failed" : "review";
      setStatusFilter([status]);
      const tower = model.towers.find((t) => t.floors.some((f) => f.status === status));
      const floor = tower?.floors.find((f) => f.status === status);
      if (tower) selectTower(tower.id, floor?.taskId ?? null);
    }
  }

  const selectedOrb = model?.orbs.find((o) => o.id === selectedOrbId) ?? null;
  const selectedTower = model?.towers.find((t) => t.id === selectedTowerId) ?? null;
  const hasDetails = Boolean(selectedOrb || selectedTower);
  // Below lg the panel is an overlay: open for a selection, or on demand for the key.
  const panelOpen = hasDetails || keyOpen;
  const tab = hasDetails ? panelTab : "key";
  const c = model?.counts;

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-[5] flex flex-col overflow-hidden bg-[#05070f] text-[#d9fbff]"
      style={{ top: headerH }}
    >
      {/* Top bar: title · status banner · drawn counts */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-white/10 bg-[#070b16] px-4 py-2.5">
        <div className="shrink-0">
          <h1 className="text-sm font-bold tracking-[0.24em] text-white">THE GIBSON</h1>
          {c ? (
            <p className="mono text-[10.5px] text-gray-400" title="Every count is derived from what is drawn">
              <strong className="text-gray-200">{c.agents}</strong> agents · <strong className="text-gray-200">{c.machines}</strong> machines ·{" "}
              <strong className="text-gray-200">{c.towers}</strong> towers · <strong className="text-gray-200">{c.openFloors}</strong> open tasks
              {c.reviewTasks > 0 && <> · <span className="text-[#8be6ff]">{c.reviewTasks} in review</span></>}
              {c.byStatus.offline > 0 && <> · {c.byStatus.offline} offline</>}
            </p>
          ) : (
            <p className="mono text-[10px] tracking-[0.18em] text-[#63dff4]/80">FLEET · PROJECTS · TASKS</p>
          )}
        </div>
        <div className="flex min-w-0 flex-1 justify-center">
          {model && <StatusBanner banner={model.banner} onItem={onBannerItem} />}
        </div>
      </div>
      {model?.demo && (
        <div className="px-4 pt-2">
          <DemoBanner />
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[16.5rem_minmax(0,1fr)_21rem]">
        <aside className="hidden min-h-0 border-r border-white/10 bg-[#080d19] lg:flex lg:flex-col">
          {model && (
            <Roster
              model={model}
              selectedOrbId={selectedOrbId}
              onSelect={(id) => selectOrb(id === selectedOrbId ? null : id)}
              onHoverOrb={setHoveredOrbId}
              rowRef={(id, el) => (el ? rowRefs.current.set(id, el) : rowRefs.current.delete(id))}
              reducedMotion={reducedMotion}
            />
          )}
        </aside>

        <div className="relative min-h-0 min-w-0">
          {model === null ? (
            <LoadingState />
          ) : (
            <GibsonScene
              model={model}
              selectedTowerId={selectedTowerId}
              onTowerClick={(id) => selectTower(id)}
              selectedTaskId={selectedTaskId}
              onFloorClick={(towerId, taskId) => selectTower(towerId, taskId)}
              selectedOrbId={selectedOrbId}
              hoveredOrbId={hoveredOrbId}
              onOrbClick={(id) => selectOrb(id, true)}
              filters={filters}
              onHover={setHoverInfo}
              reducedMotion={reducedMotion}
              autoRotate={autoRotate}
              cameraCommand={cameraCommand}
              onUserInteract={() => setAutoRotate(false)}
            />
          )}

          {!model && error && (
            <div role="alert" className="absolute inset-0 flex items-center justify-center p-6">
              <div className="max-w-sm rounded-lg border border-red-500/40 bg-[#1a0b10]/90 p-4 text-sm text-red-200">
                <p className="font-semibold">Could not load the fleet.</p>
                <p className="mono mt-1 text-[12px] text-red-300/80">{error}</p>
                <p className="mt-2 text-[12px] text-gray-400">Retrying every few seconds.</p>
              </div>
            </div>
          )}

          {model && (
            <>
              <div className="pointer-events-none absolute inset-x-3 bottom-3 flex flex-wrap items-end justify-between gap-2">
                <div className="mono pointer-events-auto rounded bg-[#05070f]/70 px-1.5 text-[10px] leading-5 text-gray-500">
                  <time dateTime={model.generatedAt} title={model.generatedAt}>
                    updated {new Date(model.generatedAt).toLocaleTimeString()}
                  </time>
                  {error && <div className="text-red-400">poll error: {error} (showing last good data)</div>}
                </div>
                <div className="pointer-events-auto flex items-center gap-1.5" role="toolbar" aria-label="Camera controls">
                  <button type="button" className={`${toolBtn} lg:hidden`} aria-pressed={keyOpen} onClick={() => setKeyOpen((v) => !v)} title="Show the key and filters">
                    Key
                  </button>
                  <button type="button" className={toolBtn} onClick={() => camera("fit")} title="Fit everything in view (F)">Fit</button>
                  <button type="button" className={toolBtn} onClick={() => camera("reset")} title="Reset camera (R)">Reset</button>
                  <button type="button" className={toolBtn} onClick={() => camera("zoom-out")} aria-label="Zoom out" title="Zoom out (−)">−</button>
                  <button type="button" className={toolBtn} onClick={() => camera("zoom-in")} aria-label="Zoom in" title="Zoom in (+)">+</button>
                  <button
                    type="button"
                    className={toolBtn}
                    aria-pressed={autoRotate}
                    disabled={reducedMotion}
                    onClick={() => setAutoRotate((v) => !v)}
                    title={reducedMotion ? "Disabled: reduced motion is on" : "Slowly orbit the scene"}
                  >
                    {autoRotate ? "❚❚ Rotate" : "▶ Rotate"}
                  </button>
                </div>
              </div>
              <p className="mono pointer-events-none absolute left-3 top-3 rounded-md bg-[#05070f]/70 px-2 py-1 text-[10.5px] text-gray-400">
                drag to orbit · scroll to zoom · click an agent · <Kbd>↑</Kbd><Kbd>↓</Kbd> cycle · <Kbd>Esc</Kbd> close
              </p>
            </>
          )}
        </div>

        <aside
          className={`min-h-0 flex-col border-l border-white/10 bg-[#080d19] ${panelOpen ? "absolute inset-y-0 right-0 z-20 flex w-[min(21rem,100vw)] lg:static lg:w-auto" : "hidden lg:flex"}`}
        >
          <div className="flex border-b border-white/10 text-[12px]" role="tablist">
            {(["details", "key"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                disabled={t === "details" && !hasDetails}
                onClick={() => setPanelTab(t)}
                className={`flex-1 px-3 py-2 capitalize transition-colors disabled:text-gray-600 ${tab === t ? "border-b-2 border-white text-white" : "text-gray-400 hover:text-gray-200"}`}
              >
                {t === "key" ? "Key & controls" : "Details"}
              </button>
            ))}
            {keyOpen && !hasDetails && (
              <button type="button" onClick={() => setKeyOpen(false)} aria-label="Close key" className="px-3 text-gray-400 hover:text-white lg:hidden">
                ×
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {model && tab === "details" && selectedOrb && (
              <AgentPanel orb={selectedOrb} onClose={() => selectOrb(null)} onShowTower={(id) => selectTower(id)} />
            )}
            {model && tab === "details" && !selectedOrb && selectedTower && (
              <TowerPanel
                tower={selectedTower}
                agents={model.orbs.filter((o) => o.towerId === selectedTower.id)}
                selectedTaskId={selectedTaskId}
                onSelectTask={(id) => setSelectedTaskId(id === selectedTaskId ? null : id)}
                onSelectAgent={(id) => selectOrb(id, true)}
                onClose={() => selectTower(null)}
              />
            )}
            {model && tab === "key" && (
              <LegendPanel
                model={model}
                statusFilter={statusFilter}
                platformFilter={platformFilter}
                onToggleStatus={(s) => setStatusFilter((p) => (p.includes(s) ? p.filter((x) => x !== s) : [...p, s]))}
                onTogglePlatforms={(ps) =>
                  setPlatformFilter((prev) =>
                    ps.every((p) => prev.includes(p)) ? prev.filter((p) => !ps.includes(p)) : [...new Set([...prev, ...ps])],
                  )
                }
                onClear={() => {
                  setStatusFilter([]);
                  setPlatformFilter([]);
                }}
              />
            )}
          </div>
        </aside>
      </div>

      {hoverInfo && <GibsonTooltip info={hoverInfo} />}
    </div>
  );
}
