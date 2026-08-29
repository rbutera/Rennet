{
  "targets": [
    {
      "target_name": "rennet-exclusive-move",
      "type": "executable",
      "sources": ["exclusive-namespace-move.c"],
      "cflags": ["-std=c11", "-Wall", "-Wextra", "-Werror", "-g0"],
      "xcode_settings": {
        "GCC_C_LANGUAGE_STANDARD": "c11",
        "GCC_GENERATE_DEBUGGING_SYMBOLS": "NO",
        "GCC_TREAT_WARNINGS_AS_ERRORS": "YES",
        "WARNING_CFLAGS": ["-Wall", "-Wextra"]
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions": ["/std:c11", "/Brepro"],
          "DebugInformationFormat": 0,
          "WarnAsError": "true",
          "WarningLevel": 4
        },
        "VCLinkerTool": {
          "AdditionalOptions": ["/Brepro"],
          "GenerateDebugInformation": "false",
          "LinkIncremental": 1
        }
      },
      "conditions": [
        ["OS==\"linux\"", { "ldflags": ["-Wl,--build-id=none"] }]
      ]
    }
  ]
}
