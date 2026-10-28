"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { mergePolledSkills, readApiError, skillsQuery } from "./SkillHelpers";
import type { SkillDetail, SkillSummary, SkillsListResponse } from "./skills-types";

function isSkillsListResponse(value: unknown): value is SkillsListResponse {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  const upstream = body.upstream;
  if (!upstream || typeof upstream !== "object" || !Array.isArray(body.skills)) return false;
  const row = upstream as Record<string, unknown>;
  return typeof row.source === "string" && (row.sha === null || typeof row.sha === "string") && (row.syncedAt === null || typeof row.syncedAt === "string") && typeof row.driftCount === "number";
}

const POLL_MS = 15_000;

export function useSkills({ q, runtime, category = "all" }: { q: string; runtime: string; category?: string }): {
  data: SkillsListResponse | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  mutateSkill: (id: string, next: SkillSummary) => void;
  holdSkill: (id: string, held: boolean) => void;
} {
  const [data, setData] = useState<SkillsListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const heldRef = useRef(new Set<string>());
  const epoch = useRef(0);

  const load = useCallback(async () => {
    const my = ++epoch.current;
    try {
      const res = await fetch(`/api/skills${skillsQuery({ q, runtime, category })}`, { cache: "no-store" });
      if (my !== epoch.current) return;
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        throw new Error(readApiError(body, `skills API ${res.status}`));
      }
      const json: unknown = await res.json();
      if (my !== epoch.current) return;
      if (!isSkillsListResponse(json)) throw new Error("skills API returned an unexpected payload");
      setData((prev) => ({
        upstream: json.upstream,
        skills: mergePolledSkills(prev?.skills ?? [], json.skills ?? [], heldRef.current),
      }));
      setError(null);
    } catch (e) {
      if (my !== epoch.current) return;
      setError(e instanceof Error ? e.message : "skills API failed");
    } finally {
      if (my === epoch.current) setLoading(false);
    }
  }, [q, runtime]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const mutateSkill = useCallback((id: string, next: SkillSummary) => {
    setData((prev) => {
      if (!prev) return prev;
      return { ...prev, skills: prev.skills.map((skill) => (skill.id === id ? next : skill)) };
    });
  }, []);

  const holdSkill = useCallback((id: string, held: boolean) => {
    if (held) heldRef.current.add(id);
    else heldRef.current.delete(id);
  }, []);

  return { data, error, loading, reload: load, mutateSkill, holdSkill };
}

export function useSkill(id: string): {
  data: SkillDetail | null;
  error: string | null;
  loading: boolean;
  notFound: boolean;
} {
  const [data, setData] = useState<SkillDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setData(null);
    setError(null);
    setNotFound(false);

    async function load() {
      if (!id) {
        if (alive) {
          setNotFound(true);
          setLoading(false);
        }
        return;
      }
      try {
        const res = await fetch(`/api/skills/${encodeURIComponent(id)}`, { cache: "no-store" });
        if (!alive) return;
        if (res.status === 404) {
          setNotFound(true);
          setLoading(false);
          return;
        }
        if (!res.ok) {
          const body: unknown = await res.json().catch(() => null);
          throw new Error(readApiError(body, `skills API ${res.status}`));
        }
        const json = (await res.json()) as SkillDetail;
        if (!alive) return;
        setData(json);
        setLoading(false);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : "skills API failed");
        setLoading(false);
      }
    }

    void load();
    return () => {
      alive = false;
    };
  }, [id]);

  return { data, error, loading, notFound };
}
