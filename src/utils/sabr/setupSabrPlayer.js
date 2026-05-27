// Entry point for the SABR playback path. Lazy-loaded by VideoPlayer.vue
// only when a video's availableModes.sabr block is selected, so non-SABR
// users don't download the LuanRT bundle.
//
// Returns the wrapper-MPD data: URI + a teardown function the caller
// can use to dispose the adapter when the video unloads.

import { SabrStreamingAdapter } from "googlevideo/sabr-streaming-adapter";
import { ShakaPlayerAdapter } from "./ShakaPlayerAdapter.ts";
import { generate_sabr_dash_file } from "../DashUtils.js";

/**
 * @param {object} args
 * @param {object} args.shakaPlayer - already-attached shaka.Player instance
 * @param {object} args.sabr - response.availableModes.sabr (sessionUrl, ustreamerConfig, formats)
 * @param {number} args.duration - top-level video duration in seconds
 * @param {() => Promise<object>} args.onRefresh - called by Layer 1 RELOAD_PLAYER_RESPONSE
 *        and by the visibility/403 fallbacks. Must return a fresh
 *        `availableModes.sabr` object (sessionUrl, ustreamerConfig, formats).
 * @returns {Promise<{ manifestUri: string, dispose: () => void }>}
 */
export async function setupSabrPlayer({ shakaPlayer, sabr, duration, onRefresh }) {
    // Initialise LuanRT's adapter
    const adapter = new SabrStreamingAdapter({
        playerAdapter: new ShakaPlayerAdapter(),
        clientInfo: {
            clientName: 3, // ANDROID
            clientVersion: "21.03.36",
            osName: "Android",
            osVersion: "15",
        },
    });

    // Layer 1 — server-driven proactive refresh. Server tells us the session
    // is about to expire by including a RELOAD_PLAYER_RESPONSE UMP frame in a
    // normal response; the adapter fires this callback.
    let lastRefreshTimestamp = Date.now();
    const applyRefreshed = freshSabr => {
        adapter.setStreamingURL(freshSabr.sessionUrl);
        adapter.setUstreamerConfig(freshSabr.ustreamerConfig);
        adapter.setServerAbrFormats(freshSabr.formats);
        lastRefreshTimestamp = Date.now();
    };

    const refresh = async () => {
        try {
            const fresh = await onRefresh();
            if (fresh) applyRefreshed(fresh);
        } catch (err) {
            console.warn("[SABR] session refresh failed:", err);
        }
    };

    adapter.onReloadPlayerResponse(refresh);

    // Initial state
    applyRefreshed(sabr);
    adapter.attach(shakaPlayer);

    // Layer 2 — wake-up check. If the tab was hidden for a long time the
    // session URL may have expired (signed URLs are ~6h). On visibility
    // returning, refresh proactively if our last refresh was a long time ago.
    const SESSION_AGE_THRESHOLD_MS = 5 * 60 * 60 * 1000; // 5h
    const onVisibilityChange = () => {
        if (!document.hidden && Date.now() - lastRefreshTimestamp > SESSION_AGE_THRESHOLD_MS) {
            refresh();
        }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    // Layer 3 — hard fallback. If a SABR POST returns 403/410 despite the
    // proactive paths, the adapter will surface it as a Shaka error which
    // the caller's existing error handling catches; the caller can then
    // call dispose() and re-setup. We don't intercept that here because
    // Shaka's error pipeline already handles network errors uniformly.

    // Build the wrapper MPD from the format list
    const mpdXml = generate_sabr_dash_file(sabr.formats, duration);
    const manifestUri = "data:application/dash+xml;charset=utf-8;base64," + btoa(mpdXml);

    const dispose = () => {
        document.removeEventListener("visibilitychange", onVisibilityChange);
        try {
            adapter.dispose?.();
        } catch (e) {
            console.warn("[SABR] adapter dispose error:", e);
        }
    };

    return { manifestUri, dispose };
}
