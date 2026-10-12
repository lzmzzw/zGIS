import { useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { ExternalLink, GitBranch, Hash, RefreshCw, Scale } from "lucide-react";
import packageJson from "../package.json";
import { api, desktop } from "./bridge";
import "./about-settings.css";

const links = {
  github: "https://github.com/lzmzzw/zGIS",
  license: "https://www.gnu.org/licenses/gpl-3.0.html",
  releases: "https://github.com/lzmzzw/zGIS/releases",
};
type LinkTarget = keyof typeof links;
type UpdateState =
  | { status: "idle" | "checking" | "current" | "unpublished" | "error" }
  | { status: "available"; latestVersion?: string }
  | {
      status: "downloading" | "ready";
      latestVersion: string;
      installation?: "restart" | "manual";
    };

export default function AboutSettings({
  onInstall,
}: {
  onInstall: (version: string) => void;
}) {
  const [version, setVersion] = useState(packageJson.version);
  const [update, setUpdate] = useState<UpdateState>({ status: "idle" });
  const [linkError, setLinkError] = useState("");
  const [downloadError, setDownloadError] = useState("");
  const epoch = useRef(0);
  const pending = useRef(false);
  const linkRequest = useRef(0);
  useEffect(() => {
    const current = ++epoch.current;
    if (desktop) {
      void getVersion()
        .then((value) => {
          if (epoch.current === current && value.trim())
            setVersion(value.trim());
        })
        .catch(() => {});
    }
    return () => {
      epoch.current++;
      pending.current = false;
    };
  }, []);

  async function openLink(target: LinkTarget) {
    const current = epoch.current;
    const request = ++linkRequest.current;
    setLinkError("");
    try {
      await api.openProjectLink(target);
    } catch {
      if (epoch.current === current && linkRequest.current === request)
        setLinkError("打开链接失败，请重试。");
    }
  }
  async function checkUpdate() {
    if (pending.current) return;
    pending.current = true;
    const current = epoch.current;
    setUpdate({ status: "checking" });
    setDownloadError("");
    try {
      const result = await api.checkAppUpdate();
      if (epoch.current !== current) return;
      if (result.currentVersion.trim())
        setVersion(result.currentVersion.trim());
      setUpdate(
        result.status === "available"
          ? { status: "available", latestVersion: result.latestVersion }
          : { status: result.status },
      );
    } catch {
      if (epoch.current === current) setUpdate({ status: "error" });
    } finally {
      if (epoch.current === current) pending.current = false;
    }
  }
  async function downloadUpdate() {
    if (
      pending.current ||
      update.status !== "available" ||
      !update.latestVersion
    )
      return;
    pending.current = true;
    const current = epoch.current;
    const latestVersion = update.latestVersion;
    setDownloadError("");
    setUpdate({ status: "downloading", latestVersion });
    try {
      const result = await api.downloadAppUpdate(latestVersion);
      if (epoch.current === current)
        setUpdate({
          status: "ready",
          latestVersion: result.version,
          installation: result.installation,
        });
    } catch {
      if (epoch.current === current) {
        setUpdate({ status: "available", latestVersion });
        setDownloadError("下载或校验失败，当前版本未改变，请重试。");
      }
    } finally {
      if (epoch.current === current) pending.current = false;
    }
  }
  async function installManual(version: string) {
    if (pending.current) return;
    pending.current = true;
    const current = epoch.current;
    setDownloadError("");
    try {
      await api.installAppUpdate(version);
    } catch {
      if (epoch.current === current)
        setDownloadError("打开安装包失败，请重试。");
    } finally {
      if (epoch.current === current) pending.current = false;
    }
  }
  function projectLink(
    target: LinkTarget,
    label: string,
    accessibleLabel = label,
  ) {
    return desktop ? (
      <button
        type="button"
        className="quiet about-settings-link"
        aria-label={accessibleLabel}
        onClick={() => void openLink(target)}
      >
        {label}
        <ExternalLink aria-hidden="true" />
      </button>
    ) : (
      <a
        className="about-settings-link"
        href={links[target]}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={accessibleLabel}
      >
        {label}
        <ExternalLink aria-hidden="true" />
      </a>
    );
  }
  const updateText =
    update.status === "downloading"
      ? "正在下载并校验更新…"
      : update.status === "ready"
        ? `v${update.latestVersion} 已下载并通过校验${update.installation === "manual" ? "，打开后拖入应用程序文件夹" : "，安装时将保存工作区并重启"}`
        : update.status === "checking"
          ? "检查中…"
          : update.status === "current"
            ? "当前已是最新版本"
            : update.status === "unpublished"
              ? "暂无可用的发布版本"
              : update.status === "error"
                ? "检查失败，请重试"
                : update.status === "available"
                  ? update.latestVersion
                    ? `发现新版本 v${update.latestVersion.replace(/^v/i, "")}`
                    : "发现新版本"
                  : desktop
                    ? "未检查"
                    : "GitHub Releases";
  return (
    <div className="settings-about">
      <div className="about-settings-cards">
        <div className="about-settings-card">
          <strong>
            <Hash aria-hidden="true" />
            版本
          </strong>
          <span className="about-settings-value">
            v{version.replace(/^v/i, "")}
          </span>
        </div>
        <div className="about-settings-card">
          <strong>
            <GitBranch aria-hidden="true" />
            GitHub
          </strong>
          <span className="about-settings-value">github.com/lzmzzw/zGIS</span>
          <div className="about-settings-actions">
            {projectLink("github", "打开", "打开 GitHub")}
          </div>
        </div>
        <div className="about-settings-card">
          <strong>
            <Scale aria-hidden="true" />
            开源协议
          </strong>
          <span className="about-settings-value">GPL 3.0</span>
          <div className="about-settings-actions">
            {projectLink("license", "查看", "查看开源协议")}
          </div>
        </div>
        <div className="about-settings-card">
          <strong>
            <RefreshCw aria-hidden="true" />
            更新
          </strong>
          <span className="about-settings-value" role="status">
            {updateText}
          </span>
          <div className="about-settings-actions">
            {desktop ? (
              <>
                {update.status === "available" &&
                  projectLink("releases", "查看更新")}
                {update.status === "available" && update.latestVersion && (
                  <button type="button" onClick={() => void downloadUpdate()}>
                    下载更新
                  </button>
                )}
                {update.status === "ready" && (
                  <button
                    type="button"
                    onClick={() =>
                      update.installation === "manual"
                        ? void installManual(update.latestVersion)
                        : onInstall(update.latestVersion)
                    }
                  >
                    {update.installation === "manual"
                      ? "打开安装包"
                      : "覆盖安装并重启"}
                  </button>
                )}
                <button
                  type="button"
                  disabled={
                    update.status === "checking" ||
                    update.status === "downloading"
                  }
                  onClick={() => void checkUpdate()}
                >
                  {update.status === "checking" ? "检查中…" : "检查更新"}
                </button>
              </>
            ) : (
              projectLink("releases", "查看发布页")
            )}
          </div>
        </div>
      </div>
      {linkError && (
        <p className="warning" role="alert">
          {linkError}
        </p>
      )}
      {downloadError && (
        <p className="warning" role="alert">
          {downloadError}
        </p>
      )}
    </div>
  );
}
