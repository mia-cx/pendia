/**
 * DeviceProfiles as clients post them in PlaybackInfo, for tests. Infuse is
 * closed source, so its profile is a direct-play client that opens MKV with
 * TrueHD and draws every subtitle itself. Swiftfin's is its AVPlayer profile
 * reduced to HLS. Findroid's is the empty "Direct play all" profile it sends.
 */
export const deviceProfiles = {
  infuse: {
    Name: "Infuse",
    MaxStreamingBitrate: 120_000_000,
    DirectPlayProfiles: [
      {
        Type: "Video",
        Container: "mkv,mp4,m4v,mov",
        VideoCodec: "h264,hevc,av1,vp9,mpeg2video",
        AudioCodec: "aac,ac3,eac3,truehd,dts,flac,opus,mp3",
      },
    ],
    TranscodingProfiles: [],
    CodecProfiles: [],
    SubtitleProfiles: [
      { Format: "srt", Method: "Embed" },
      { Format: "ass", Method: "Embed" },
      { Format: "pgssub", Method: "Embed" },
    ],
  },
  swiftfin: {
    Name: "Swiftfin AVPlayer, HLS only",
    MaxStreamingBitrate: 20_000_000,
    DirectPlayProfiles: [],
    TranscodingProfiles: [
      {
        Type: "Video",
        Container: "mp4",
        Protocol: "hls",
        Context: "Streaming",
        VideoCodec: "h264,hevc",
        AudioCodec: "aac,ac3,eac3",
        MaxAudioChannels: "8",
        MinSegments: 2,
        BreakOnNonKeyFrames: true,
      },
    ],
    CodecProfiles: [
      {
        Type: "Video",
        Codec: "h264",
        Conditions: [
          {
            Condition: "EqualsAny",
            Property: "VideoProfile",
            Value: "high|main|baseline|constrained baseline",
            IsRequired: false,
          },
          {
            Condition: "LessThanEqual",
            Property: "VideoLevel",
            Value: "52",
            IsRequired: false,
          },
        ],
      },
      {
        Type: "Video",
        Codec: "hevc",
        Conditions: [
          {
            Condition: "EqualsAny",
            Property: "VideoRangeType",
            Value: "SDR|HDR10|HLG|DOVIWithHDR10",
            IsRequired: false,
          },
        ],
      },
    ],
    SubtitleProfiles: [
      { Format: "vtt", Method: "Hls" },
      { Format: "srt", Method: "External" },
    ],
  },
  findroid: {
    Name: "Direct play all",
    MaxStaticBitrate: 1_000_000_000,
    MaxStreamingBitrate: 1_000_000_000,
    CodecProfiles: [],
    ContainerProfiles: [],
    DirectPlayProfiles: [],
    TranscodingProfiles: [],
    SubtitleProfiles: [
      { Format: "srt", Method: "External" },
      { Format: "ass", Method: "External" },
    ],
  },
};
