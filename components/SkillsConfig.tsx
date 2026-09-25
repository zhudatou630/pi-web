"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useI18n } from "@/hooks/useI18n";
import type {
  SkillInfo as Skill,
  SkillInstallScope,
  SkillSearchResult,
  SkillsResponse,
  SkillUpdateResult,
} from "@/lib/api-types";
import {
  ConfigButton,
  ConfigPanelShell,
  ConfigSwitch,
  CountedTitle,
  SettingsBackLink,
  SettingsDetailPage,
  SettingsGroup,
  SettingsLinkRow,
  SettingsRow,
  SettingsSearch,
  SettingsSegmented,
} from "./SettingsUi";

function shortenPath(p: string): string {
  // Match common home dir patterns: /Users/xxx, /home/xxx
  return p.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

function sourceLabel(skill: Skill): string {
  const src = skill.sourceInfo?.source;
  const scope = skill.sourceInfo?.scope;
  if (scope === "user" || src === "user") return "global";
  if (scope === "project" || src === "project") return "project";
  return "path";
}

export function orderSkillsByDormancy<
  T extends Pick<Skill, "disableModelInvocation">,
>(skills: T[]): T[] {
  return [
    ...skills.filter((skill) => !skill.disableModelInvocation),
    ...skills.filter((skill) => skill.disableModelInvocation),
  ];
}

function updateKey(skill: Skill): string | null {
  return skill.install
    ? `${skill.install.scope}\0${skill.install.package}`
    : null;
}

function shortVersion(version?: string): string {
  return version ? version.slice(0, 8) : "unknown";
}

function SkillDetail({
  skill,
  cwd,
  onToggle,
  toggling,
  saveError,
  updateStatus,
  checkingUpdate,
  updating,
  updateError,
  onCheckUpdate,
  onUpdate,
  onDelete,
  deleting,
  deleteError,
}: {
  skill: Skill;
  cwd: string;
  onToggle: (skill: Skill) => void;
  toggling: boolean;
  saveError: string | null;
  updateStatus?: SkillUpdateResult;
  checkingUpdate: boolean;
  updating: boolean;
  updateError: string | null;
  onCheckUpdate: () => void;
  onUpdate: () => void;
  onDelete: () => void;
  deleting: boolean;
  deleteError: string | null;
}) {
  const { t } = useI18n();
  const label = sourceLabel(skill);
  const enabled = !skill.disableModelInvocation;

  function displayPath(p: string): string {
    if (label === "project" && p.startsWith(cwd)) {
      const rel = p.slice(cwd.length).replace(/^[/\\]/, "");
      return `./${rel}`;
    }
    return shortenPath(p);
  }

  const updateAvailable = updateStatus?.state === "update-available";
  const statusText = checkingUpdate
    ? t("i18n.checking")
    : updateStatus && !updateAvailable
      ? updateStatus.state === "up-to-date"
        ? t("i18n.upToDate")
        : updateStatus.state === "unsupported"
          ? t("i18n.automaticChecksUnavailable")
          : updateStatus.message || t("i18n.checkFailed")
      : null;

  return (
    <SettingsDetailPage
      title={skill.name}
      meta={(
        <>
          <span className={`config-scope-tag${label === "project" ? " is-project" : ""}`}>{label}</span>
          <span className="config-detail-path" title={skill.filePath}>{displayPath(skill.filePath)}</span>
        </>
      )}
      description={skill.description}
    >
      <SettingsGroup>
        <SettingsRow
          label={t("skills.modelInvocation")}
          description={enabled ? t("skills.modelInvocationOn") : t("i18n.hiddenButInvocable")}
        >
          <ConfigSwitch
            checked={enabled}
            loading={toggling}
            label={t("skills.modelInvocation")}
            onChange={() => onToggle(skill)}
          />
        </SettingsRow>
        {saveError && <p role="alert" className="settings-row-message is-error">{saveError}</p>}
        {skill.install && (
          <SettingsRow
            label={t("i18n.version")}
            description={(
              <>
                <span className="is-mono">{shortVersion(updateStatus?.currentVersion ?? skill.install.versionHash)}</span>
                {updateAvailable && <> → <span className="is-mono is-accent">{shortVersion(updateStatus.latestVersion)}</span></>}
                {statusText && <> · <span className={updateStatus?.state === "error" ? "is-error" : undefined}>{statusText}</span></>}
              </>
            )}
          >
            {updateAvailable ? (
              <ConfigButton variant="primary" size="small" onClick={onUpdate} disabled={updating || checkingUpdate}>
                {updating ? t("i18n.updating") : t("i18n.update")}
              </ConfigButton>
            ) : skill.install.canCheckForUpdates && (
              <ConfigButton size="small" onClick={onCheckUpdate} disabled={checkingUpdate || updating}>
                {t("i18n.check")}
              </ConfigButton>
            )}
          </SettingsRow>
        )}
        {updateError && <p role="alert" className="settings-row-message is-error">{updateError}</p>}
        {skill.install?.skillsShUrl && (
          <SettingsRow label={t("skills.source")}>
            <a href={skill.install.skillsShUrl} target="_blank" rel="noreferrer" title={skill.install.skillsShUrl} className="settings-link">
              {skill.install.skillsShUrl.replace(/^https?:\/\//, "")} ↗
            </a>
          </SettingsRow>
        )}
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow
          label={t("skills.deleteTitle")}
          description={skill.removable ? t("skills.deleteDescription") : t("skills.notRemovable")}
        >
          {skill.removable && (
            <ConfigButton variant="danger" size="small" onClick={onDelete} disabled={deleting}>
              {t("i18n.delete")}
            </ConfigButton>
          )}
        </SettingsRow>
        {deleteError && <p role="alert" className="settings-row-message is-error">{deleteError}</p>}
      </SettingsGroup>
    </SettingsDetailPage>
  );
}

function AddSkillPanel({
  cwd,
  installedPackages,
  projectResourcesLoaded,
  onInstalled,
}: {
  cwd: string;
  installedPackages: Record<SkillInstallScope, ReadonlySet<string>>;
  projectResourcesLoaded: boolean;
  onInstalled: () => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SkillSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [newlyInstalledPkgs, setNewlyInstalledPkgs] = useState<Set<string>>(
    new Set(),
  );
  const [scope, setScope] = useState<"global" | "project">("global");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const search = useCallback(async (q: string) => {
    if (!q.trim()) return;
    setSearching(true);
    setSearchError(null);
    setResults([]);
    try {
      const res = await fetch("/api/skills/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q.trim() }),
      });
      const d = (await res.json()) as {
        results?: SkillSearchResult[];
        error?: string;
      };
      if (d.error) {
        setSearchError(d.error);
        return;
      }
      setResults(d.results ?? []);
      if ((d.results ?? []).length === 0) setSearchError(t("skills.noResults"));
    } catch (e) {
      setSearchError(String(e));
    } finally {
      setSearching(false);
    }
  }, [t]);

  const install = useCallback(
    async (pkg: string) => {
      setInstalling(pkg);
      setInstallError(null);
      try {
        const res = await fetch("/api/skills/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ package: pkg, scope, cwd }),
        });
        const d = (await res.json()) as { success?: boolean; error?: string };
        if (!res.ok || d.error) {
          setInstallError(d.error ?? `HTTP ${res.status}`);
          return;
        }
        setNewlyInstalledPkgs((prev) =>
          new Set(prev).add(`${scope}:${pkg}`),
        );
        onInstalled();
      } catch (e) {
        setInstallError(String(e));
      } finally {
        setInstalling(null);
      }
    },
    [onInstalled, scope, cwd],
  );

  const installPath =
    scope === "global"
      ? "~/.pi/agent/skills/"
      : `${shortenPath(cwd)}/.pi/skills/`;

  return (
    <SettingsDetailPage
      title={t("i18n.addSkill")}
      description={(
        <>
          {t("skills.addDescription")}{" "}
          <a href="https://skills.sh" target="_blank" rel="noreferrer" className="settings-link">skills.sh ↗</a>
        </>
      )}
    >
      <SettingsGroup>
        <div className="settings-search">
          <input
            ref={inputRef}
            className="settings-search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") search(query);
            }}
            placeholder={t("i18n.skillSearchPlaceholder")}
            aria-label={t("i18n.skillSearchPlaceholder")}
          />
          <ConfigButton
            variant="primary"
            onClick={() => search(query)}
            disabled={searching || !query.trim()}
          >
            {searching ? t("i18n.searching") : t("i18n.search")}
          </ConfigButton>
        </div>
        <SettingsRow label={t("skills.installTo")} description={<span className="is-mono">{installPath}</span>}>
          <SettingsSegmented
            label={t("skills.installTo")}
            value={scope}
            onChange={setScope}
            options={[
              { value: "global", label: t("skills.scope.global") },
              {
                value: "project",
                label: t("skills.scope.project"),
                disabled: !projectResourcesLoaded,
                title: projectResourcesLoaded ? undefined : t("trust.projectScopeUnavailable"),
              },
            ]}
          />
        </SettingsRow>
        {searchError && <p role="alert" className="settings-row-message is-error">{searchError}</p>}
        {installError && <p role="alert" className="settings-row-message is-error">{installError}</p>}
      </SettingsGroup>

      {results.length > 0 && (
        <SettingsGroup title={`${t("skills.results")} · ${results.length}`}>
          {results.map((r) => {
            const isInstalled =
              installedPackages[scope].has(r.package) ||
              newlyInstalledPkgs.has(`${scope}:${r.package}`);
            const isInstalling = installing === r.package;
            // "owner/repo@skill": the skill is the name, the repo is where it comes from.
            const atIdx = r.package.indexOf("@");
            const repopart = atIdx > -1 ? r.package.slice(0, atIdx) : r.package;
            const skillpart = atIdx > -1 ? r.package.slice(atIdx + 1) : null;
            return (
              <SettingsRow
                key={r.package}
                label={skillpart ?? repopart}
                description={(
                  <>
                    <span className="is-mono">{repopart}</span>
                    {" · "}{r.installs}
                    {r.url && <>{" · "}<a href={r.url} target="_blank" rel="noreferrer" className="settings-link">skills.sh ↗</a></>}
                  </>
                )}
              >
                {isInstalled ? (
                  <span className="settings-row-status is-success">✓ {t("i18n.installed")}</span>
                ) : (
                  <ConfigButton size="small" onClick={() => void install(r.package)} disabled={installing !== null}>
                    {isInstalling ? t("i18n.installing") : t("i18n.install")}
                  </ConfigButton>
                )}
              </SettingsRow>
            );
          })}
        </SettingsGroup>
      )}
    </SettingsDetailPage>
  );
}

export function SkillsConfig({
  cwd,
  onClose,
  embedded = false,
}: {
  cwd: string;
  onClose: () => void;
  embedded?: boolean;
}) {
  const { t } = useI18n();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const [saveError, setSaveError] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "detail" | "add">("list");
  const [filter, setFilter] = useState("");
  const [updateStatuses, setUpdateStatuses] = useState<Record<string, SkillUpdateResult>>({});
  const [checkingUpdates, setCheckingUpdates] = useState<Set<string>>(new Set());
  const [checkingAll, setCheckingAll] = useState(false);
  const [updatingSkill, setUpdatingSkill] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [projectResourcesLoaded, setProjectResourcesLoaded] = useState(true);
  const [deletingSkill, setDeletingSkill] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const loadSkills = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/skills?cwd=${encodeURIComponent(cwd)}`);
      const d = (await res.json()) as Partial<SkillsResponse> & { error?: string };
      if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
      const list = d.skills ?? [];
      setSkills(list);
      setProjectResourcesLoaded(d.projectResourcesLoaded ?? true);
      return list;
    } catch (e) {
      setError(String(e));
      return [];
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    setUpdateStatuses({});
    setUpdateError(null);
    void loadSkills();
  }, [cwd]); // eslint-disable-line react-hooks/exhaustive-deps

  const checkForUpdates = useCallback(async (skill?: Skill) => {
    const targets = skill
      ? [skill]
      : skills.filter((item) => Boolean(item.install));
    const keys = targets
      .map(updateKey)
      .filter((key): key is string => Boolean(key));
    if (keys.length === 0) return;

    setUpdateError(null);
    setCheckingUpdates((current) => new Set([...current, ...keys]));
    if (!skill) setCheckingAll(true);
    try {
      const res = await fetch("/api/skills/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd,
          package: skill?.install?.package,
          scope: skill?.install?.scope,
        }),
      });
      const data = (await res.json()) as {
        updates?: SkillUpdateResult[];
        error?: string;
      };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setUpdateStatuses((current) => {
        const next = { ...current };
        for (const update of data.updates ?? []) {
          next[`${update.scope}\0${update.package}`] = update;
        }
        return next;
      });
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCheckingUpdates((current) => {
        const next = new Set(current);
        for (const key of keys) next.delete(key);
        return next;
      });
      if (!skill) setCheckingAll(false);
    }
  }, [cwd, skills]);

  const updateInstalledSkill = useCallback(async (skill: Skill) => {
    if (!skill.install) return;
    const key = updateKey(skill)!;
    setUpdatingSkill(key);
    setUpdateError(null);
    try {
      const res = await fetch("/api/skills/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd,
          package: skill.install.package,
          scope: skill.install.scope,
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        skill?: Skill;
        error?: string;
      };
      if (!res.ok || data.error || !data.success) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      await loadSkills();
      const versionHash = data.skill?.install?.versionHash;
      setUpdateStatuses((current) => ({
        ...current,
        [key]: {
          package: skill.install!.package,
          scope: skill.install!.scope,
          state: "up-to-date",
          currentVersion: versionHash,
          latestVersion: versionHash,
        },
      }));
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : String(e));
    } finally {
      setUpdatingSkill(null);
    }
  }, [cwd, loadSkills]);

  const toggle = useCallback(async (skill: Skill) => {
    const next = !skill.disableModelInvocation;
    setToggling((s) => new Set(s).add(skill.filePath));
    setSaveError(null);
    try {
      const res = await fetch("/api/skills", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd,
          filePath: skill.filePath,
          disableModelInvocation: next,
        }),
      });
      const d = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || d.error) {
        setSaveError(d.error ?? `HTTP ${res.status}`);
        return;
      }
      setSkills((prev) =>
        prev.map((s) =>
          s.filePath === skill.filePath
            ? { ...s, disableModelInvocation: next }
            : s,
        ),
      );
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setToggling((s) => {
        const n = new Set(s);
        n.delete(skill.filePath);
        return n;
      });
    }
  }, [cwd]);

  const deleteSkill = useCallback(async (skill: Skill) => {
    const message = [
      t("skills.deleteConfirm", { path: shortenPath(skill.filePath) }),
      skill.install ? t("skills.deleteViaSkillsSh") : null,
      t("skills.deleteReloadHint"),
    ].filter(Boolean).join("\n\n");
    if (!window.confirm(message)) return;
    setDeletingSkill(skill.filePath);
    setDeleteError(null);
    try {
      const res = await fetch("/api/skills", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, filePath: skill.filePath }),
      });
      const d = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !d.success) throw new Error(d.error ?? `HTTP ${res.status}`);
      setSelected(null);
      setView("list");
      await loadSkills();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeletingSkill(null);
    }
  }, [cwd, loadSkills, t]);

  const selectedSkill = skills.find((s) => s.filePath === selected) ?? null;
  const openList = () => { setView("list"); setDeleteError(null); };
  const availableUpdates = Object.values(updateStatuses).filter((status) => status.state === "update-available").length;
  const needle = filter.trim().toLowerCase();
  const visibleSkills = needle
    ? skills.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(needle))
    : skills;
  // Where a skill lives is the grouping; where it was installed from is a per-row detail.
  const groups = (["project", "global", "path"] as const)
    .map((scope) => ({ label: t(`skills.group.${scope}`), matches: (skill: Skill) => sourceLabel(skill) === scope }))
    .map(({ label, matches }) => ({ label, skills: orderSkillsByDormancy(visibleSkills.filter(matches)) }))
    .filter((group) => group.skills.length > 0);

  return (
    <ConfigPanelShell embedded={embedded} title={t("common.skills")} subtitle={shortenPath(cwd)} closeLabel={t("i18n.close")} onClose={onClose}>
      <div className="settings-scroll">
        <div className="settings-page">
          {view === "add" ? (
            <>
              <SettingsBackLink label={t("common.skills")} onClick={openList} />
              <AddSkillPanel
                cwd={cwd}
                projectResourcesLoaded={projectResourcesLoaded}
                installedPackages={{
                  global: new Set(skills.filter((skill) => skill.install?.scope === "global").map((skill) => skill.install!.package)),
                  project: new Set(skills.filter((skill) => skill.install?.scope === "project").map((skill) => skill.install!.package)),
                }}
                onInstalled={() => { void loadSkills(); }}
              />
            </>
          ) : view === "detail" && selectedSkill ? (
            <>
              <SettingsBackLink label={t("common.skills")} onClick={openList} />
              <SkillDetail
                key={selectedSkill.filePath}
                skill={selectedSkill}
                cwd={cwd}
                onToggle={toggle}
                toggling={toggling.has(selectedSkill.filePath)}
                saveError={saveError}
                updateStatus={updateKey(selectedSkill) ? updateStatuses[updateKey(selectedSkill)!] : undefined}
                checkingUpdate={updateKey(selectedSkill) ? checkingUpdates.has(updateKey(selectedSkill)!) : false}
                updating={updatingSkill === updateKey(selectedSkill)}
                updateError={updateError}
                onCheckUpdate={() => void checkForUpdates(selectedSkill)}
                onUpdate={() => void updateInstalledSkill(selectedSkill)}
                onDelete={() => void deleteSkill(selectedSkill)}
                deleting={deletingSkill === selectedSkill.filePath}
                deleteError={deleteError}
              />
            </>
          ) : (
            <>
              {!projectResourcesLoaded && <p role="status" className="settings-row-message is-warning">{t("trust.skillsNotLoaded")}</p>}
              <div className="settings-toolbar">
                <SettingsSearch value={filter} onChange={setFilter} placeholder={t("skills.filterPlaceholder")} />
                <span className="settings-toolbar-spacer" />
                {skills.some((skill) => Boolean(skill.install)) && (
                  <ConfigButton size="small" variant="ghost" onClick={() => void checkForUpdates()} disabled={checkingAll || updatingSkill !== null}>
                    {checkingAll ? t("i18n.checking") : availableUpdates > 0 ? `${t("i18n.checkUpdates")} · ${availableUpdates}` : t("i18n.checkUpdates")}
                  </ConfigButton>
                )}
                <ConfigButton size="small" onClick={() => setView("add")}>{t("i18n.addSkill")}</ConfigButton>
              </div>
              {(saveError || updateError) && <p role="alert" className="settings-row-message is-error">{saveError || updateError}</p>}
              {loading ? (
                <p className="settings-row-message">{t("i18n.loading")}</p>
              ) : error ? (
                <p role="alert" className="settings-row-message is-error">{error}</p>
              ) : groups.length === 0 ? (
                <p className="settings-row-message">{needle ? t("skills.noResults") : t("i18n.noSkills")}</p>
              ) : groups.map((group) => (
                <SettingsGroup key={group.label} title={<CountedTitle label={group.label} count={group.skills.length} />}>
                  {group.skills.map((skill) => {
                    const key = updateKey(skill);
                    const hasUpdate = key ? updateStatuses[key]?.state === "update-available" : false;
                    return (
                      <SettingsLinkRow
                        key={skill.filePath}
                        label={<>{skill.name}{skill.install?.skillsShUrl && <span className="settings-row-tag">skills.sh</span>}</>}
                        description={skill.description}
                        muted={skill.disableModelInvocation}
                        title={skill.filePath}
                        onOpen={() => { setSelected(skill.filePath); setDeleteError(null); setView("detail"); }}
                      >
                        {hasUpdate && <span className="settings-row-status is-accent">{t("i18n.updateAvailable")}</span>}
                        <ConfigSwitch
                          checked={!skill.disableModelInvocation}
                          loading={toggling.has(skill.filePath)}
                          label={t("skills.modelInvocation")}
                          onChange={() => void toggle(skill)}
                        />
                      </SettingsLinkRow>
                    );
                  })}
                </SettingsGroup>
              ))}
            </>
          )}
        </div>
      </div>
    </ConfigPanelShell>
  );
}
