#if defined(__linux__)
#define _GNU_SOURCE
#endif

#if defined(_WIN32)

#include <stdio.h>
#include <windows.h>

enum move_exit_code {
  MOVE_EXIT_DESTINATION_EXISTS = 10,
  MOVE_EXIT_PATH_MISSING = 11,
  MOVE_EXIT_CROSS_DEVICE = 12,
  MOVE_EXIT_UNSUPPORTED = 13,
  MOVE_EXIT_FAILED = 14,
  MOVE_EXIT_USAGE = 64
};

static int exit_code_for_error(DWORD error_code) {
  switch (error_code) {
    case ERROR_FILE_EXISTS:
    case ERROR_ALREADY_EXISTS:
      return MOVE_EXIT_DESTINATION_EXISTS;
    case ERROR_FILE_NOT_FOUND:
    case ERROR_PATH_NOT_FOUND:
      return MOVE_EXIT_PATH_MISSING;
    case ERROR_NOT_SAME_DEVICE:
      return MOVE_EXIT_CROSS_DEVICE;
    case ERROR_NOT_SUPPORTED:
    case ERROR_INVALID_FUNCTION:
    case ERROR_CALL_NOT_IMPLEMENTED:
      return MOVE_EXIT_UNSUPPORTED;
    default:
      return MOVE_EXIT_FAILED;
  }
}

int wmain(int argc, wchar_t *argv[]) {
  DWORD error_code;

  if (argc != 3) {
    fwprintf(stderr, L"native-code=%lu\n", (unsigned long)ERROR_INVALID_PARAMETER);
    return MOVE_EXIT_USAGE;
  }

  if (MoveFileExW(argv[1], argv[2], MOVEFILE_WRITE_THROUGH) != 0) {
    return 0;
  }

  error_code = GetLastError();
  fwprintf(stderr, L"native-code=%lu\n", (unsigned long)error_code);
  return exit_code_for_error(error_code);
}

#elif defined(__APPLE__) || defined(__linux__)

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>

enum move_exit_code {
  MOVE_EXIT_DESTINATION_EXISTS = 10,
  MOVE_EXIT_PATH_MISSING = 11,
  MOVE_EXIT_CROSS_DEVICE = 12,
  MOVE_EXIT_UNSUPPORTED = 13,
  MOVE_EXIT_FAILED = 14,
  MOVE_EXIT_USAGE = 64
};

static int exit_code_for_error(int error_code) {
  switch (error_code) {
    case EEXIST:
      return MOVE_EXIT_DESTINATION_EXISTS;
    case ENOENT:
      return MOVE_EXIT_PATH_MISSING;
    case EXDEV:
      return MOVE_EXIT_CROSS_DEVICE;
    case ENOSYS:
      return MOVE_EXIT_UNSUPPORTED;
#if defined(ENOTSUP)
    case ENOTSUP:
      return MOVE_EXIT_UNSUPPORTED;
#endif
#if defined(EOPNOTSUPP) && (!defined(ENOTSUP) || EOPNOTSUPP != ENOTSUP)
    case EOPNOTSUPP:
      return MOVE_EXIT_UNSUPPORTED;
#endif
    default:
      return MOVE_EXIT_FAILED;
  }
}

int main(int argc, char *argv[]) {
  int result;
  int error_code;

  if (argc != 3) {
    fprintf(stderr, "native-code=%d\n", EINVAL);
    return MOVE_EXIT_USAGE;
  }

#if defined(__APPLE__)
  result = renameatx_np(AT_FDCWD, argv[1], AT_FDCWD, argv[2], RENAME_EXCL);
#else
  result = renameat2(AT_FDCWD, argv[1], AT_FDCWD, argv[2], RENAME_NOREPLACE);
#endif
  if (result == 0) {
    return 0;
  }

  error_code = errno;
  fprintf(stderr, "native-code=%d\n", error_code);
  return exit_code_for_error(error_code);
}

#else
#error Unsupported platform
#endif
