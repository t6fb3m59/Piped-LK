// Entry point for the SABR playback path. Lazy-loaded by VideoPlayer.vue
// only when a video's availableModes.sabr block is selected.
//
// FreeTube-style: we build a SabrManifest JSON, hand it to Shaka as
// `data:application/sabr+json,...`, and the vendored SabrManifestParser +
// SabrSchemePlugin take over from there. See ./SabrManifestParser.js and
// ./SabrSchemePlugin.js for the heavy lifting (both vendored from
// https://github.com/FreeTubeApp/FreeTube, MIT licensed).
//
// Returns { manifestUri, dispose, onLoaded }:
//   - manifestUri: data: URL to hand to shaka.Player.load(uri)
//   - dispose: teardown (call on unmount)
//   - onLoaded: must be called by the caller AFTER player.load() resolves so
//     the SabrSchemePlugin can read the parsed shaka manifest for bufferedRange
//     calculations on subsequent segment fetches

import { MANIFEST_TYPE_SABR } from "./SabrManifestParser.js";
// Side-effect import: SabrManifestParser registers itself with Shaka at module load.
import "./SabrManifestParser.js";
import { setupSabrScheme } from "./SabrSchemePlugin.js";

// Mimics the YT Music Android client identity Piped's backend already uses
// when extracting via NPE — must stay in sync so the SABR server treats
// player requests as coming from the same client that established the session.
const ANDROID_CLIENT_INFO = {
    clientName: 3,
    clientVersion: "21.03.36",
    osName: "Android",
    osVersion: "15",
};

// Suppress Shaka's buffering spinner in the last ~second of SABR playback —
// audio/video tracks differ slightly in length, so Shaka's BufferingObserver
// briefly thinks we're buffering at the end. Toggled per-player by attribute.
const spinnerSuppressStyle = document.createElement("style");
spinnerSuppressStyle.textContent =
    "[data-shaka-player-container][data-sabr-near-end] .shaka-spinner-container{display:none}";
document.head.appendChild(spinnerSuppressStyle);

/**
 * @param {object} args
 * @param {shaka.Player} args.shakaPlayer attached shaka.Player instance
 * @param {object} args.sabr response.availableModes.sabr (sessionUrl, ustreamerConfig, cpn, formats)
 * @param {number} args.duration top-level video duration in seconds
 * @param {Array} [args.captions] caption tracks
 * @param {Array} [args.storyboards] storyboard tracks
 * @param {() => Promise<object|undefined>} [args.fetchFreshSabr] resolves a fresh
 *   availableModes.sabr block (new sessionUrl/ustreamerConfig) for an in-place
 *   session refresh when the SABR server demands a reload
 * @param {() => void} [args.onReloadFailed] called when the in-place refresh
 *   can't recover; caller should do a full player rebuild
 * @returns {{ manifestUri: string, dispose: () => void, onLoaded: () => void }}
 */
export function setupSabrPlayer({
    shakaPlayer,
    sabr,
    duration,
    captions = [],
    storyboards = [],
    fetchFreshSabr,
    onReloadFailed,
}) {
    const sabrData = {
        url: sabr.sessionUrl,
        poToken: "",
        ustreamerConfig: sabr.ustreamerConfig,
        clientInfo: ANDROID_CLIENT_INFO,
    };

    // Adapt Piped's subtitle shape ({url, code, mimeType, name}) to FreeTube's
    // SabrManifest caption shape ({id, label, mimeType, language, url}).
    const adaptedCaptions = (captions || [])
        .filter(c => c?.url && c?.mimeType)
        .map(c => ({
            id: c.code || c.url,
            label: c.name || c.code || "",
            mimeType: c.mimeType,
            language: c.code || "und",
            url: c.url,
        }));

    // FreeTube derives presentation duration from the minimum per-format
    // approxDurationMs — the overall video duration from /player is often
    // longer than what any single track actually contains, which causes
    // the audio to cut out before video ends.
    const perFormatDurationsMs = (sabr.formats || [])
        .map(f => f.approxDurationMs)
        .filter(d => typeof d === "number" && d > 0);
    const trueDuration = perFormatDurationsMs.length > 0 ? Math.min(...perFormatDurationsMs) / 1000 : duration;

    const sabrManifest = {
        duration: trueDuration,
        formats: sabr.formats,
        captions: adaptedCaptions,
        storyboards,
    };
    const manifestUri = "data:" + MANIFEST_TYPE_SABR + "," + encodeURIComponent(JSON.stringify(sabrManifest));

    const videoEl = shakaPlayer.getMediaElement?.();
    const playerWidth = { value: videoEl?.clientWidth || 1920 };
    const playerHeight = { value: videoEl?.clientHeight || 1080 };

    let parsedManifest = null;
    const sabrStream = setupSabrScheme(
        sabrData,
        () => shakaPlayer,
        () => parsedManifest,
        playerWidth,
        playerHeight,
    );

    sabrStream.onBackoffRequested?.(({ backoffMs }) => {
        console.log(`[SABR] backoff requested: ${Math.round(backoffMs)}ms`);
    });

    // On a SABR reload, swap in a fresh session in place and resume — no
    // teardown, no seek, buffered media keeps playing. Re-arm after each
    // success since onReloadOnce only fires once. If anything fails, hand off
    // to the caller for a full player rebuild.
    //
    // A flat 1s delay before each attempt keeps a persistently-failing session
    // (e.g. a transient backend/YouTube outage) from turning into a request
    // storm — the reload loop is otherwise ungated and fires as fast as
    // /streams responds.
    const RELOAD_BACKOFF_MS = 1000;
    const armReload = () => {
        sabrStream.onReloadOnce?.(async () => {
            console.log("[SABR] session reload requested");
            await new Promise(resolve => setTimeout(resolve, RELOAD_BACKOFF_MS));
            try {
                const fresh = fetchFreshSabr ? await fetchFreshSabr() : null;
                if (!fresh?.sessionUrl) throw new Error("no fresh SABR session");
                sabrStream.refreshSession?.({
                    sessionUrl: fresh.sessionUrl,
                    ustreamerConfig: fresh.ustreamerConfig,
                });
                armReload();
                shakaPlayer.retryStreaming?.();
            } catch (e) {
                console.warn("[SABR] in-place session refresh failed, requesting full reload:", e);
                if (onReloadFailed) onReloadFailed();
            }
        });
    };
    armReload();

    // See spinnerSuppressStyle above for why. Toggle attribute on each timeupdate
    // (includes the final tick before `ended` fires, so no need for a separate
    // ended listener).
    const sabrContainer = videoEl?.closest?.("[data-shaka-player-container]");
    const onTimeUpdate = () => {
        if (!sabrContainer) return;
        const remaining = (videoEl.duration || 0) - videoEl.currentTime;
        sabrContainer.toggleAttribute("data-sabr-near-end", videoEl.ended || (remaining >= 0 && remaining < 1.5));
    };
    videoEl?.addEventListener("timeupdate", onTimeUpdate);

    const onLoaded = () => {
        try {
            parsedManifest = shakaPlayer.getManifest?.();
        } catch (e) {
            console.warn("[SABR] failed to grab parsed manifest:", e);
        }
    };

    const dispose = () => {
        videoEl?.removeEventListener("timeupdate", onTimeUpdate);
        sabrContainer?.removeAttribute("data-sabr-near-end");
        try {
            sabrStream.cleanup?.();
        } catch (e) {
            console.warn("[SABR] cleanup error:", e);
        }
    };

    return { manifestUri, dispose, onLoaded };
}
