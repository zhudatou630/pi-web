"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useI18n } from "@/hooks/useI18n";
import { getJson, peekJson, settingsUrls } from "@/lib/settings-cache";
import type {
  SkillInfo as Skill,
  SkillInstallScope,
  SkillSearchResult,
  SkillsResponse,
  SkillUpdateResult,
} from "@/lib/api-types";
import { ProjectOverrideTag } from "./ProjectOverride";
import { ReloadNotice } from "./ReloadNotice";
import {
  ConfigButton,
  ConfigPanelShell,
  ConfigSwitch,
  CountedTitle,
  SettingsBackLink,
  SettingsDetailPage,
  SettingsGroup,
  SettingsLinkRow,
  SettingsLoading,
  SettingsRow,
  SettingsSearch,
  SettingsSegmented,
} from "./SettingsUi";

function shortenPath(p: string): string {
  // Match common home dir patterns: /Users/xxx, /home/xxx
  return p.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

/** A package owns its SKILL.md: writing to it dirties a git checkout or is lost on update. */
function isPackageSkill(skill: Skill): boolean {
  return skill.sourceInfo?.origin === "package";
}

/** A standalone skill file inside this project (`.pi/skills`, `.agents/skills`, project settings paths). */
function isProjectFile(skill: Skill): boolean {
  return !isPackageSkill(skill) && skill.sourceInfo?.scope === "project";
}

/** Readable package name from a pi package source: npm spec, git URL, or local path. */
export function packageDisplayName(source: string): string {
  const bare = source.replace(/^(npm|git|github|https?|ssh):/, "").replace(/[\/]+$/, "");
  const last = bare.startsWith("@") && !bare.includes("/") ? bare : bare.split(/[\/]/).pop() ?? bare;
  return last.replace(/(.)@.*$/, "$1") || source;
}

/** Where a skill comes from, which is how the list is grouped. */
function sourceGroup(skill: Skill): { key: string; kind: "mine" | "projectFiles" | "package"; name?: string } {
  if (isPackageSkill(skill)) {
    const source = skill.sourceInfo.source ?? "";
    return { key: `package:${source}`, kind: "package", name: packageDisplayName(source) };
  }
  return isProjectFile(skill) ? { key: "projectFiles", kind: "projectFiles" } : { key: "mine", kind: "mine" };
}

/** Switched on for the page's scope: the global switch, or the effective state when there is none. */
function isOn(skill: Skill): boolean {
  return skill.globalEnabled ?? skill.enabled;
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
  onToggleEnabled,
  onToggleAutoInvoke,
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
  onToggleEnabled: (skill: Skill) => void;
  onToggleAutoInvoke: (skill: Skill) => void;
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
  const group = sourceGroup(skill);
  const autoInvoke = !skill.disableModelInvocation;
  const on = isOn(skill);

  function displayPath(p: string): string {
    if (isProjectFile(skill) && p.startsWith(cwd)) {
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
          <span className={`config-scope-tag${group.kind === "projectFiles" ? " is-project" : ""}`}>
            {group.kind === "package" ? t("skills.group.package", { name: group.name ?? "" }) : t(group.kind === "mine" ? "skills.group.mine" : "skills.group.projectFiles")}
          </span>
          <span className="config-detail-path" title={skill.filePath}>{displayPath(skill.filePath)}</span>
        </>
      )}
      description={skill.description}
    >
      <SettingsGroup>
        <SettingsRow
          label={t("skills.enabled")}
          description={skill.globalEnabled === null ? t("skills.noGlobalSwitch") : t("skills.enabledDescription")}
        >
          {skill.globalEnabled !== null && (
            <ConfigSwitch
              checked={skill.globalEnabled}
              loading={toggling}
              label={t("skills.enabled")}
              onChange={() => onToggleEnabled(skill)}
            />
          )}
        </SettingsRow>
        {/* A property of the skill file, so it applies everywhere and only once the skill is on. */}
        <SettingsRow
          label={t("skills.modelInvocation")}
          description={isPackageSkill(skill)
            ? t("skills.packageManaged")
            : !on ? t("skills.autoInvokeNeedsEnabled")
              : autoInvoke ? t("skills.modelInvocationOn") : t("i18n.hiddenButInvocable")}
        >
          <ConfigSwitch
            checked={autoInvoke}
            disabled={isPackageSkill(skill) || !on}
            loading={toggling}
            label={t("skills.modelInvocation")}
            onChange={() => onToggleAutoInvoke(skill)}
          />
        </SettingsRow>
        {saveError && <p role="alert" className="settings-row-message is-error">{saveError}</p>}
        {skill.install && (
          <SettingsRow
            label={t("i18n.version")}
            description={(
              <>
                <span>{shortVersion(updateStatus?.currentVersion ?? skill.install.versionHash)}</span>
                {updateAvailable && <> → <span className="is-accent">{shortVersion(updateStatus.latestVersion)}</span></>}
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
        <SettingsRow label={t("skills.installTo")} description={installPath}>
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
                    <span>{repopart}</span>
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
  sessionId = null,
  onClose,
  onReloaded,
  onChanged,
  embedded = false,
}: {
  cwd: string;
  sessionId?: string | null;
  onClose: () => void;
  onReloaded?: () => void;
  /** A global switch changed what the Plugins/Project pages show. */
  onChanged?: () => void;
  embedded?: boolean;
}) {
  const { t } = useI18n();
  // The last reply paints at once; the mount load then revalidates it.
  const [seed] = useState(() => {
    const reply = peekJson<Partial<SkillsResponse> & { error?: string }>(settingsUrls.skills(cwd));
    return reply?.ok && !reply.data.error ? reply.data : null;
  });
  const [skills, setSkills] = useState<Skill[]>(seed?.skills ?? []);
  const [loading, setLoading] = useState(!seed);
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
  const [projectResourcesLoaded, setProjectResourcesLoaded] = useState(seed?.projectResourcesLoaded ?? true);
  const [deletingSkill, setDeletingSkill] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [reloadNeeded, setReloadNeeded] = useState(false);

  const loadSkills = useCallback(async () => {
    setError(null);
    try {
      const res = await getJson<Partial<SkillsResponse> & { error?: string }>(settingsUrls.skills(cwd));
      const d = res.data;
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

  const patchSkill = useCallback(async (skill: Skill, change: { enabled: boolean } | { disableModelInvocation: boolean }) => {
    setToggling((s) => new Set(s).add(skill.filePath));
    setSaveError(null);
    try {
      const res = await fetch("/api/skills", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, filePath: skill.filePath, ...change }),
      });
      const d = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || d.error) {
        setSaveError(d.error ?? `HTTP ${res.status}`);
        return;
      }
      // Switching a skill on or off also moves its effective and project state: reload the list.
      await loadSkills();
      setReloadNeeded(true);
      if ("enabled" in change) onChanged?.();
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setToggling((s) => {
        const n = new Set(s);
        n.delete(skill.filePath);
        return n;
      });
    }
  }, [cwd, loadSkills, onChanged]);

  const toggleEnabled = useCallback((skill: Skill) => patchSkill(skill, { enabled: !skill.globalEnabled }), [patchSkill]);
  const toggleAutoInvoke = useCallback(
    (skill: Skill) => patchSkill(skill, { disableModelInvocation: !skill.disableModelInvocation }),
    [patchSkill],
  );

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
      setReloadNeeded(true);
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
  // Grouped by where a skill comes from: yours, this project's files, then one group per package.
  const sourceGroups = new Map<string, { label: string; rank: string; skills: Skill[] }>();
  for (const skill of skills) {
    const group = sourceGroup(skill);
    if (sourceGroups.has(group.key)) continue;
    sourceGroups.set(group.key, group.kind === "package"
      ? { label: t("skills.group.package", { name: group.name ?? "" }), rank: `2${group.name}`, skills: [] }
      : { label: t(group.kind === "mine" ? "skills.group.mine" : "skills.group.projectFiles"), rank: group.kind === "mine" ? "0" : "1", skills: [] });
  }
  const matches = (key: string) => (skill: Skill) => sourceGroup(skill).key === key;
  const groups = [...sourceGroups.entries()]
    .sort(([, a], [, b]) => a.rank.localeCompare(b.rank))
    .map(([key, group]) => ({ label: group.label, skills: orderSkillsByDormancy(visibleSkills.filter(matches(key))) }))
    .filter((group) => group.skills.length > 0);

  return (
    <ConfigPanelShell embedded={embedded} title={t("common.skills")} subtitle={shortenPath(cwd)} closeLabel={t("i18n.close")} onClose={onClose}>
      {reloadNeeded && <ReloadNotice sessionId={sessionId} onReloaded={onReloaded} onDone={() => setReloadNeeded(false)} />}
      <div className="settings-scroll">
        <div key={loading ? "loading" : view} className="settings-page">
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
                onToggleEnabled={(skill) => void toggleEnabled(skill)}
                onToggleAutoInvoke={(skill) => void toggleAutoInvoke(skill)}
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
                <SettingsLoading label={t("i18n.loading")} />
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
                        label={(
                          <>
                            {skill.name}
                            {skill.disableModelInvocation && <span className="settings-row-tag">{t("skills.tag.manual")}</span>}
                            {skill.install?.skillsShUrl && <span className="settings-row-tag">skills.sh</span>}
                          </>
                        )}
                        description={skill.description}
                        muted={!isOn(skill)}
                        title={skill.filePath}
                        onOpen={() => { setSelected(skill.filePath); setDeleteError(null); setView("detail"); }}
                      >
                        {hasUpdate && <span className="settings-row-status is-accent">{t("i18n.updateAvailable")}</span>}
                        <ProjectOverrideTag value={skill.projectOverride} />
                        {skill.globalEnabled === null ? (
                          // No global switch: a project file or project package, switched on the This project page.
                          !isProjectFile(skill) && <span className="settings-row-status">{t("project.projectOnly")}</span>
                        ) : (
                          <ConfigSwitch
                            checked={skill.globalEnabled}
                            loading={toggling.has(skill.filePath)}
                            label={t("skills.enabled")}
                            onChange={() => void toggleEnabled(skill)}
                          />
                        )}
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
