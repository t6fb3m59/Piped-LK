// Based of https://github.com/GilgusMaximus/yt-dash-manifest-generator/blob/master/src/DashGenerator.js
import { XMLBuilder } from "fast-xml-parser";

export function generate_dash_file_from_formats(VideoFormats, VideoLength) {
    const generatedJSON = generate_xmljs_json_from_data(VideoFormats, VideoLength);
    const builder = new XMLBuilder({
        ignoreAttributes: false,
        allowBooleanAttributes: true,
        suppressBooleanAttributes: false,
        attributeNamePrefix: "_",
    });
    return builder.build(generatedJSON);
}

function generate_xmljs_json_from_data(VideoFormatArray, VideoLength) {
    const convertJSON = {
        "?xml": {
            _version: "1.0",
            _encoding: "utf-8",
            MPD: {
                _xmlns: "urn:mpeg:dash:schema:mpd:2011",
                _profiles: "urn:mpeg:dash:profile:full:2011",
                _minBufferTime: "PT1.5S",
                _type: "static",
                _mediaPresentationDuration: `PT${VideoLength}S`,
                Period: {
                    AdaptationSet: generate_adaptation_set(VideoFormatArray),
                },
            },
        },
    };
    return convertJSON;
}

function generate_adaptation_set(VideoFormatArray) {
    const adaptationSets = [];

    let mimeAudioObjs = [];

    VideoFormatArray.forEach(videoFormat => {
        // the dual formats should not be used
        if (
            (videoFormat.mimeType.includes("video") && !videoFormat.videoOnly) ||
            videoFormat.mimeType.includes("application")
        ) {
            return;
        }

        const audioTrackId = videoFormat.audioTrackId;
        const mimeType = videoFormat.mimeType;

        for (let i = 0; i < mimeAudioObjs.length; i++) {
            const mimeAudioObj = mimeAudioObjs[i];

            if (mimeAudioObj.audioTrackId == audioTrackId && mimeAudioObj.mimeType == mimeType) {
                mimeAudioObj.videoFormats.push(videoFormat);
                return;
            }
        }

        mimeAudioObjs.push({
            audioTrackId,
            mimeType,
            videoFormats: [videoFormat],
        });
    });

    mimeAudioObjs.forEach(mimeAudioObj => {
        const adapSet = {
            _id: mimeAudioObj.audioTrackId,
            _lang: mimeAudioObj.audioTrackId?.substr(0, 2),
            _mimeType: mimeAudioObj.mimeType,
            _startWithSAP: "1",
            _subsegmentAlignment: "true",
            Representation: [],
        };

        let isVideoFormat = false;

        if (mimeAudioObj.mimeType.includes("video")) {
            isVideoFormat = true;
            adapSet["_scanType"] = "progressive";
        }

        for (var i = 0; i < mimeAudioObj.videoFormats.length; i++) {
            const videoFormat = mimeAudioObj.videoFormats[i];
            if (isVideoFormat) {
                adapSet.Representation.push(generate_representation_video(videoFormat));
            } else {
                adapSet.Representation.push(generate_representation_audio(videoFormat));
            }
        }

        adaptationSets.push(adapSet);
    });
    return adaptationSets;
}

function generate_representation_audio(Format) {
    const representation = {
        _id: Format.itag,
        _codecs: Format.codec,
        _bandwidth: Format.bitrate,
        AudioChannelConfiguration: {
            _schemeIdUri: "urn:mpeg:dash:23003:3:audio_channel_configuration:2011",
            _value: "2",
        },
        BaseURL: Format.url,
        SegmentBase: {
            _indexRange: `${Format.indexStart}-${Format.indexEnd}`,
            Initialization: {
                _range: `${Format.initStart}-${Format.initEnd}`,
            },
        },
    };
    return representation;
}

function generate_representation_video(Format) {
    const representation = {
        _id: Format.itag,
        _codecs: Format.codec,
        _bandwidth: Format.bitrate,
        _width: Format.width,
        _height: Format.height,
        _maxPlayoutRate: "1",
        _frameRate: Format.fps,
        BaseURL: Format.url,
        SegmentBase: {
            _indexRange: `${Format.indexStart}-${Format.indexEnd}`,
            Initialization: {
                _range: `${Format.initStart}-${Format.initEnd}`,
            },
        },
    };
    return representation;
}

// ─── SABR-mode wrapper-MPD generator ─────────────────────────────────────────
//
// Builds a DASH manifest whose <BaseURL>s are sabr:// markers. Shaka loads
// it but the actual byte fetches are intercepted by LuanRT's
// SabrStreamingAdapter, which rewrites the URL to the proxied SABR session
// endpoint and POSTs a protobuf body. The manifest is just Shaka's
// configuration document — it doesn't itself participate in any byte flow.
//
// Sources its per-format metadata from the backend's
// availableModes.sabr.formats[] array (LuanRT SabrFormat shape).

// LuanRT formatKey: `${itag}:${xtags || ''}`. Matches googlevideo's
// FormatKeyUtils.createKey so the adapter's request interceptor can map
// each request back to a known SabrFormat.
function sabrFormatKey(format) {
    return `${format.itag}:${format.xtags || ""}`;
}

const SABR_AUDIO_SEGMENT_DURATION_MS = 10000;
const SABR_VIDEO_SEGMENT_DURATION_MS = 5000;

function extract_codec_from_mime(mimeType) {
    if (!mimeType) return undefined;
    const m = mimeType.match(/codecs="([^"]+)"/);
    return m ? m[1] : undefined;
}

function base_mime(mimeType) {
    return mimeType ? mimeType.split(";")[0].trim() : undefined;
}

function generate_sabr_representation(format, isVideo) {
    const key = sabrFormatKey(format);
    const codec = extract_codec_from_mime(format.mimeType);
    const sabrRoot = `sabr://${isVideo ? "video" : "audio"}`;
    const keyParam = `key=${encodeURIComponent(key)}`;
    const duration = isVideo ? SABR_VIDEO_SEGMENT_DURATION_MS : SABR_AUDIO_SEGMENT_DURATION_MS;

    const representation = {
        _id: String(format.itag),
        _codecs: codec,
        _bandwidth: format.bitrate,
        BaseURL: `${sabrRoot}?${keyParam}`,
        SegmentTemplate: {
            _media: `${sabrRoot}?${keyParam}&sq=$Number$`,
            _initialization: `${sabrRoot}?${keyParam}&init=1`,
            _startNumber: "0",
            _duration: String(duration),
            _timescale: "1000",
        },
    };

    if (isVideo) {
        if (format.width) representation._width = format.width;
        if (format.height) representation._height = format.height;
        representation._maxPlayoutRate = "1";
    } else {
        representation.AudioChannelConfiguration = {
            _schemeIdUri: "urn:mpeg:dash:23003:3:audio_channel_configuration:2011",
            _value: "2",
        };
    }

    return representation;
}

function group_sabr_adaptation_sets(sabrFormats) {
    // Group by (audioTrackId, base mimeType) — same shape as the existing
    // generate_adaptation_set for the legacy path.
    const groups = [];
    sabrFormats.forEach(format => {
        const isVideo = !!format.width;
        const mimeType = base_mime(format.mimeType);
        const audioTrackId = isVideo ? null : format.audioTrackId || null;

        const existing = groups.find(g => g.mimeType === mimeType && g.audioTrackId === audioTrackId);
        if (existing) {
            existing.formats.push(format);
        } else {
            groups.push({
                mimeType,
                audioTrackId,
                isVideo,
                formats: [format],
            });
        }
    });

    return groups.map(group => {
        const adapSet = {
            _id: group.audioTrackId || group.mimeType,
            _mimeType: group.mimeType,
            _startWithSAP: "1",
            _segmentAlignment: "true",
            Representation: group.formats.map(f => generate_sabr_representation(f, group.isVideo)),
        };
        if (group.isVideo) {
            adapSet._scanType = "progressive";
        }
        if (group.audioTrackId) {
            adapSet._lang = group.audioTrackId.substring(0, 2);
        }
        return adapSet;
    });
}

export function generate_sabr_dash_file(sabrFormats, videoLength) {
    const convertJSON = {
        "?xml": {
            _version: "1.0",
            _encoding: "utf-8",
            MPD: {
                _xmlns: "urn:mpeg:dash:schema:mpd:2011",
                _profiles: "urn:mpeg:dash:profile:isoff-live:2011",
                _minBufferTime: "PT1.5S",
                _type: "static",
                _mediaPresentationDuration: `PT${videoLength}S`,
                Period: {
                    AdaptationSet: group_sabr_adaptation_sets(sabrFormats),
                },
            },
        },
    };
    const builder = new XMLBuilder({
        ignoreAttributes: false,
        allowBooleanAttributes: true,
        suppressBooleanAttributes: false,
        attributeNamePrefix: "_",
    });
    return builder.build(convertJSON);
}
