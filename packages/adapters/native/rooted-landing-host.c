#if defined(__linux__)
#define _GNU_SOURCE
#endif

#include <node_api.h>

#if defined(_WIN32)

static napi_value rooted_landing_constructor(napi_env env, napi_callback_info info) {
  (void)info;
  napi_throw_error(env, NULL, "RootedLandingHost is unsupported on Windows");
  return NULL;
}

NAPI_MODULE_INIT() {
  napi_value constructor;
  napi_status status = napi_define_class(env, "RootedLandingHost", NAPI_AUTO_LENGTH,
                                          rooted_landing_constructor, NULL, 0, NULL,
                                          &constructor);
  if (status != napi_ok) {
    napi_throw_error(env, NULL, "failed to define RootedLandingHost");
    return NULL;
  }
  status = napi_set_named_property(env, exports, "RootedLandingHost", constructor);
  if (status != napi_ok) {
    napi_throw_error(env, NULL, "failed to export RootedLandingHost");
    return NULL;
  }
  return exports;
}

#elif defined(__APPLE__) || defined(__linux__)

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

typedef struct {
  int source_fd;
  int worker_fd;
  int info_parent_fd;
  char *info_name;
  bool closed;
} rooted_landing_host;

typedef struct {
  char **items;
  size_t length;
  size_t capacity;
} string_list;

static bool check_napi(napi_env env, napi_status status, const char *operation) {
  const napi_extended_error_info *info;
  char message[512];

  if (status == napi_ok) return true;
  if (status == napi_pending_exception) return false;
  if (napi_get_last_error_info(env, &info) == napi_ok && info != NULL &&
      info->error_message != NULL) {
    (void)snprintf(message, sizeof(message), "%s: %s", operation, info->error_message);
  } else {
    (void)snprintf(message, sizeof(message), "%s", operation);
  }
  napi_throw_error(env, NULL, message);
  return false;
}

static napi_value throw_errno(napi_env env, const char *operation, int error_code) {
  char message[768];
  (void)snprintf(message, sizeof(message), "%s: %s (native code %d)", operation,
                 strerror(error_code), error_code);
  napi_throw_error(env, NULL, message);
  return NULL;
}

static bool throw_type(napi_env env, const char *message) {
  napi_throw_type_error(env, NULL, message);
  return false;
}

static char *duplicate_bytes(const char *value, size_t length) {
  char *copy = malloc(length + 1);
  if (copy == NULL) return NULL;
  memcpy(copy, value, length);
  copy[length] = '\0';
  return copy;
}

static bool read_string(napi_env env, napi_value value, const char *label, char **result,
                        size_t *result_length) {
  napi_valuetype type;
  size_t length;
  size_t written;
  char *bytes;
  char message[256];

  if (!check_napi(env, napi_typeof(env, value, &type), "failed to inspect argument"))
    return false;
  if (type != napi_string) {
    (void)snprintf(message, sizeof(message), "%s must be a string", label);
    return throw_type(env, message);
  }
  if (!check_napi(env, napi_get_value_string_utf8(env, value, NULL, 0, &length),
                  "failed to measure string argument"))
    return false;
  bytes = malloc(length + 1);
  if (bytes == NULL) {
    napi_throw_error(env, NULL, "out of memory while reading string argument");
    return false;
  }
  if (!check_napi(env,
                  napi_get_value_string_utf8(env, value, bytes, length + 1, &written),
                  "failed to read string argument")) {
    free(bytes);
    return false;
  }
  if (written != length || memchr(bytes, '\0', written) != NULL) {
    free(bytes);
    (void)snprintf(message, sizeof(message), "%s must not contain NUL", label);
    return throw_type(env, message);
  }
  *result = bytes;
  *result_length = length;
  return true;
}

static bool component_is_dot(const char *component, size_t length) {
  return (length == 1 && component[0] == '.') ||
         (length == 2 && component[0] == '.' && component[1] == '.');
}

static bool validate_relative_path(napi_env env, const char *path, size_t length,
                                   const char *label) {
  size_t component_start = 0;
  size_t index;
  char message[256];

  if (length == 0 || path[0] == '/' || path[length - 1] == '/') {
    (void)snprintf(message, sizeof(message), "%s must be a normalized repository-relative path",
                   label);
    return throw_type(env, message);
  }
  for (index = 0; index <= length; index += 1) {
    if (index < length && path[index] == '\\') {
      (void)snprintf(message, sizeof(message), "%s must use POSIX separators", label);
      return throw_type(env, message);
    }
    if (index == length || path[index] == '/') {
      size_t component_length = index - component_start;
      if (component_length == 0 || component_is_dot(path + component_start, component_length)) {
        (void)snprintf(message, sizeof(message),
                       "%s must be a normalized repository-relative path", label);
        return throw_type(env, message);
      }
      component_start = index + 1;
    }
  }
  return true;
}

static bool validate_absolute_path(napi_env env, const char *path, size_t length,
                                   const char *label) {
  size_t component_start = 1;
  size_t index;
  char message[256];

  if (length == 0 || path[0] != '/' || (length > 1 && path[length - 1] == '/')) {
    (void)snprintf(message, sizeof(message), "%s must be a normalized absolute path", label);
    return throw_type(env, message);
  }
  for (index = 1; index <= length; index += 1) {
    if (index < length && path[index] == '\\') {
      (void)snprintf(message, sizeof(message), "%s must use POSIX separators", label);
      return throw_type(env, message);
    }
    if (index == length || path[index] == '/') {
      size_t component_length = index - component_start;
      if (component_length == 0 || component_is_dot(path + component_start, component_length)) {
        (void)snprintf(message, sizeof(message), "%s must be a normalized absolute path", label);
        return throw_type(env, message);
      }
      component_start = index + 1;
    }
  }
  return true;
}

static int duplicate_fd(int fd) {
  int copy;
  do {
    copy = fcntl(fd, F_DUPFD_CLOEXEC, 0);
  } while (copy < 0 && errno == EINTR);
  return copy;
}

static int open_directory(const char *path) {
  int fd;
  do {
    fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  } while (fd < 0 && errno == EINTR);
  return fd;
}

static int open_directory_at(int parent_fd, const char *name) {
  int fd;
  do {
    fd = openat(parent_fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  } while (fd < 0 && errno == EINTR);
  return fd;
}

static int directory_open_error(int parent_fd, const char *name, int error_code) {
  struct stat stats;
  if ((error_code == ENOTDIR || error_code == ELOOP) &&
      fstatat(parent_fd, name, &stats, AT_SYMLINK_NOFOLLOW) == 0 && S_ISLNK(stats.st_mode))
    return ELOOP;
  return error_code;
}

static int open_absolute_directory(const char *path) {
  int current_fd = open_directory("/");
  char *copy;
  char *cursor;

  if (current_fd < 0) return -1;
  if (strcmp(path, "/") == 0) return current_fd;
  copy = duplicate_bytes(path + 1, strlen(path + 1));
  if (copy == NULL) {
    close(current_fd);
    errno = ENOMEM;
    return -1;
  }

  cursor = copy;
  while (*cursor != '\0') {
    char *separator = strchr(cursor, '/');
    int next_fd;
    if (separator != NULL) *separator = '\0';
    next_fd = open_directory_at(current_fd, cursor);
    if (next_fd < 0) {
      int error_code = directory_open_error(current_fd, cursor, errno);
      close(current_fd);
      free(copy);
      errno = error_code;
      return -1;
    }
    close(current_fd);
    current_fd = next_fd;
    if (separator == NULL) break;
    cursor = separator + 1;
  }
  free(copy);
  return current_fd;
}

static int open_parent_at(int root_fd, const char *path, int *parent_fd, char **leaf_name) {
  char *copy = duplicate_bytes(path, strlen(path));
  char *last_slash;
  char *cursor;
  int current_fd;

  if (copy == NULL) return ENOMEM;
  last_slash = strrchr(copy, '/');
  current_fd = duplicate_fd(root_fd);
  if (current_fd < 0) {
    int error_code = errno;
    free(copy);
    return error_code;
  }
  if (last_slash == NULL) {
    *leaf_name = copy;
    *parent_fd = current_fd;
    return 0;
  }

  *last_slash = '\0';
  *leaf_name = duplicate_bytes(last_slash + 1, strlen(last_slash + 1));
  if (*leaf_name == NULL) {
    close(current_fd);
    free(copy);
    return ENOMEM;
  }

  cursor = copy;
  while (*cursor != '\0') {
    char *separator = strchr(cursor, '/');
    int next_fd;
    if (separator != NULL) *separator = '\0';
    next_fd = open_directory_at(current_fd, cursor);
    if (next_fd < 0) {
      int error_code = directory_open_error(current_fd, cursor, errno);
      close(current_fd);
      free(*leaf_name);
      *leaf_name = NULL;
      free(copy);
      return error_code;
    }
    close(current_fd);
    current_fd = next_fd;
    if (separator == NULL) break;
    cursor = separator + 1;
  }

  free(copy);
  *parent_fd = current_fd;
  return 0;
}

static int ensure_parent_at(int root_fd, const char *path) {
  char *copy = duplicate_bytes(path, strlen(path));
  char *last_slash;
  char *cursor;
  int current_fd;

  if (copy == NULL) return ENOMEM;
  last_slash = strrchr(copy, '/');
  if (last_slash == NULL) {
    free(copy);
    return 0;
  }
  *last_slash = '\0';
  current_fd = duplicate_fd(root_fd);
  if (current_fd < 0) {
    int error_code = errno;
    free(copy);
    return error_code;
  }

  cursor = copy;
  while (*cursor != '\0') {
    char *separator = strchr(cursor, '/');
    int next_fd;
    if (separator != NULL) *separator = '\0';
    next_fd = open_directory_at(current_fd, cursor);
    if (next_fd < 0 && errno == ENOENT) {
      int mkdir_result;
      do {
        mkdir_result = mkdirat(current_fd, cursor, 0777);
      } while (mkdir_result < 0 && errno == EINTR);
      if (mkdir_result < 0 && errno != EEXIST) {
        int error_code = errno;
        close(current_fd);
        free(copy);
        return error_code;
      }
      next_fd = open_directory_at(current_fd, cursor);
    }
    if (next_fd < 0) {
      int error_code = directory_open_error(current_fd, cursor, errno);
      close(current_fd);
      free(copy);
      return error_code;
    }
    close(current_fd);
    current_fd = next_fd;
    if (separator == NULL) break;
    cursor = separator + 1;
  }

  close(current_fd);
  free(copy);
  return 0;
}

static int read_all_fd(int fd, unsigned char **bytes, size_t *length) {
  struct stat stats;
  size_t capacity;
  size_t used = 0;
  unsigned char *buffer;

  if (fstat(fd, &stats) < 0) return errno;
  if (stats.st_size >= 0 && (uintmax_t)stats.st_size < SIZE_MAX) {
    capacity = (size_t)stats.st_size + 1;
  } else {
    capacity = 4096;
  }
  if (capacity == 0) capacity = 1;
  buffer = malloc(capacity);
  if (buffer == NULL) return ENOMEM;

  for (;;) {
    ssize_t read_count;
    if (used == capacity) {
      size_t next_capacity;
      unsigned char *next_buffer;
      if (capacity > SIZE_MAX / 2) {
        free(buffer);
        return EOVERFLOW;
      }
      next_capacity = capacity * 2;
      next_buffer = realloc(buffer, next_capacity);
      if (next_buffer == NULL) {
        free(buffer);
        return ENOMEM;
      }
      buffer = next_buffer;
      capacity = next_capacity;
    }
    do {
      read_count = read(fd, buffer + used, capacity - used);
    } while (read_count < 0 && errno == EINTR);
    if (read_count < 0) {
      int error_code = errno;
      free(buffer);
      return error_code;
    }
    if (read_count == 0) break;
    used += (size_t)read_count;
  }
  *bytes = buffer;
  *length = used;
  return 0;
}

static int read_link_at(int parent_fd, const char *name, unsigned char **bytes, size_t *length) {
  size_t capacity = 256;
  unsigned char *buffer = malloc(capacity);
  if (buffer == NULL) return ENOMEM;

  for (;;) {
    ssize_t read_count;
    do {
      read_count = readlinkat(parent_fd, name, (char *)buffer, capacity);
    } while (read_count < 0 && errno == EINTR);
    if (read_count < 0) {
      int error_code = errno;
      free(buffer);
      return error_code;
    }
    if ((size_t)read_count < capacity) {
      *bytes = buffer;
      *length = (size_t)read_count;
      return 0;
    }
    if (capacity > SIZE_MAX / 2) {
      free(buffer);
      return EOVERFLOW;
    }
    capacity *= 2;
    {
      unsigned char *next_buffer = realloc(buffer, capacity);
      if (next_buffer == NULL) {
        free(buffer);
        return ENOMEM;
      }
      buffer = next_buffer;
    }
  }
}

static int write_all(int fd, const unsigned char *bytes, size_t length) {
  size_t written = 0;
  while (written < length) {
    ssize_t write_count;
    do {
      write_count = write(fd, bytes + written, length - written);
    } while (write_count < 0 && errno == EINTR);
    if (write_count < 0) return errno;
    if (write_count == 0) return EIO;
    written += (size_t)write_count;
  }
  return 0;
}

static int string_list_push(string_list *list, char *item) {
  if (list->length == list->capacity) {
    size_t next_capacity = list->capacity == 0 ? 16 : list->capacity * 2;
    char **next_items;
    if (next_capacity < list->capacity || next_capacity > SIZE_MAX / sizeof(*next_items))
      return EOVERFLOW;
    next_items = realloc(list->items, next_capacity * sizeof(*next_items));
    if (next_items == NULL) return ENOMEM;
    list->items = next_items;
    list->capacity = next_capacity;
  }
  list->items[list->length] = item;
  list->length += 1;
  return 0;
}

static void string_list_dispose(string_list *list) {
  size_t index;
  for (index = 0; index < list->length; index += 1) free(list->items[index]);
  free(list->items);
  list->items = NULL;
  list->length = 0;
  list->capacity = 0;
}

static char *joined_path(const char *parent, const char *name) {
  size_t parent_length = strlen(parent);
  size_t name_length = strlen(name);
  char *result;
  if (parent_length > SIZE_MAX - name_length - 2) return NULL;
  result = malloc(parent_length + name_length + 2);
  if (result == NULL) return NULL;
  memcpy(result, parent, parent_length);
  result[parent_length] = '/';
  memcpy(result + parent_length + 1, name, name_length + 1);
  return result;
}

static int compare_strings(const void *left, const void *right) {
  const char *const *left_string = left;
  const char *const *right_string = right;
  return strcmp(*left_string, *right_string);
}

static int collect_manifest_leaves(int directory_fd, const char *prefix, string_list *leaves) {
  int scan_fd = duplicate_fd(directory_fd);
  DIR *directory;
  struct dirent *entry;

  if (scan_fd < 0) return errno;
  directory = fdopendir(scan_fd);
  if (directory == NULL) {
    int error_code = errno;
    close(scan_fd);
    return error_code;
  }

  errno = 0;
  while ((entry = readdir(directory)) != NULL) {
    struct stat stats;
    char *child_path;
    int result;
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    if (fstatat(directory_fd, entry->d_name, &stats, AT_SYMLINK_NOFOLLOW) < 0) {
      if (errno == ENOENT) {
        errno = 0;
        continue;
      }
      result = errno;
      closedir(directory);
      return result;
    }
    child_path = joined_path(prefix, entry->d_name);
    if (child_path == NULL) {
      closedir(directory);
      return ENOMEM;
    }
    if (S_ISDIR(stats.st_mode)) {
      int child_fd = open_directory_at(directory_fd, entry->d_name);
      if (child_fd < 0) {
        result = errno;
        free(child_path);
        closedir(directory);
        return result;
      }
      result = collect_manifest_leaves(child_fd, child_path, leaves);
      close(child_fd);
      free(child_path);
      if (result != 0) {
        closedir(directory);
        return result;
      }
    } else {
      result = string_list_push(leaves, child_path);
      if (result != 0) {
        free(child_path);
        closedir(directory);
        return result;
      }
    }
    errno = 0;
  }
  if (errno != 0) {
    int error_code = errno;
    closedir(directory);
    return error_code;
  }
  if (closedir(directory) < 0) return errno;
  return 0;
}

static int remove_entry_at(int parent_fd, const char *name, bool recursive) {
  struct stat stats;

  if (fstatat(parent_fd, name, &stats, AT_SYMLINK_NOFOLLOW) < 0) {
    if (errno == ENOENT) return 0;
    return errno;
  }
  if (S_ISDIR(stats.st_mode)) {
    if (recursive) {
      int directory_fd = open_directory_at(parent_fd, name);
      int scan_fd;
      DIR *directory;
      struct dirent *entry;
      if (directory_fd < 0) return errno;
      scan_fd = duplicate_fd(directory_fd);
      if (scan_fd < 0) {
        int error_code = errno;
        close(directory_fd);
        return error_code;
      }
      directory = fdopendir(scan_fd);
      if (directory == NULL) {
        int error_code = errno;
        close(scan_fd);
        close(directory_fd);
        return error_code;
      }
      errno = 0;
      while ((entry = readdir(directory)) != NULL) {
        int result;
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
        result = remove_entry_at(directory_fd, entry->d_name, true);
        if (result != 0) {
          closedir(directory);
          close(directory_fd);
          return result;
        }
        errno = 0;
      }
      if (errno != 0) {
        int error_code = errno;
        closedir(directory);
        close(directory_fd);
        return error_code;
      }
      if (closedir(directory) < 0) {
        int error_code = errno;
        close(directory_fd);
        return error_code;
      }
      close(directory_fd);
    }
    if (unlinkat(parent_fd, name, AT_REMOVEDIR) < 0) {
      if (errno == ENOENT) return 0;
      return errno;
    }
    return 0;
  }
  if (unlinkat(parent_fd, name, 0) < 0 && errno != ENOENT) return errno;
  return 0;
}

static void close_host(rooted_landing_host *host) {
  if (host->closed) return;
  host->closed = true;
  if (host->source_fd >= 0) close(host->source_fd);
  if (host->worker_fd >= 0) close(host->worker_fd);
  if (host->info_parent_fd >= 0) close(host->info_parent_fd);
  host->source_fd = -1;
  host->worker_fd = -1;
  host->info_parent_fd = -1;
}

static void finalize_host(napi_env env, void *data, void *hint) {
  rooted_landing_host *host = data;
  (void)env;
  (void)hint;
  close_host(host);
  free(host->info_name);
  free(host);
}

static bool callback_host(napi_env env, napi_callback_info info, size_t expected_count,
                          napi_value *arguments, napi_value *this_value,
                          rooted_landing_host **host, bool allow_closed) {
  size_t argument_count = expected_count + 1;
  char message[160];
  void *data;

  if (!check_napi(env,
                  napi_get_cb_info(env, info, &argument_count, arguments, this_value, NULL),
                  "failed to read RootedLandingHost arguments"))
    return false;
  if (argument_count != expected_count) {
    (void)snprintf(message, sizeof(message), "expected %zu argument%s", expected_count,
                   expected_count == 1 ? "" : "s");
    return throw_type(env, message);
  }
  if (!check_napi(env, napi_unwrap(env, *this_value, &data),
                  "invalid RootedLandingHost receiver"))
    return false;
  *host = data;
  if (!allow_closed && (*host)->closed) {
    napi_throw_error(env, NULL, "RootedLandingHost is closed");
    return false;
  }
  return true;
}

static bool relative_argument(napi_env env, napi_value value, const char *label, char **path) {
  size_t length;
  if (!read_string(env, value, label, path, &length)) return false;
  if (!validate_relative_path(env, *path, length, label)) {
    free(*path);
    *path = NULL;
    return false;
  }
  return true;
}

static bool root_argument(napi_env env, napi_value value, rooted_landing_host *host, int *root_fd) {
  char *root;
  size_t length;
  if (!read_string(env, value, "root", &root, &length)) return false;
  if (length == 6 && memcmp(root, "source", 6) == 0) {
    *root_fd = host->source_fd;
  } else if (length == 6 && memcmp(root, "worker", 6) == 0) {
    *root_fd = host->worker_fd;
  } else {
    free(root);
    return throw_type(env, "root must be either source or worker");
  }
  free(root);
  return true;
}

static napi_value kind_object(napi_env env, const char *kind) {
  napi_value object;
  napi_value value;
  if (!check_napi(env, napi_create_object(env, &object), "failed to create result")) return NULL;
  if (!check_napi(env, napi_create_string_utf8(env, kind, NAPI_AUTO_LENGTH, &value),
                  "failed to create result kind"))
    return NULL;
  if (!check_napi(env, napi_set_named_property(env, object, "kind", value),
                  "failed to set result kind"))
    return NULL;
  return object;
}

static bool set_string_property(napi_env env, napi_value object, const char *name,
                                const char *value) {
  napi_value property;
  if (!check_napi(env, napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &property),
                  "failed to create string property"))
    return false;
  return check_napi(env, napi_set_named_property(env, object, name, property),
                    "failed to set string property");
}

static napi_value move_outcome(napi_env env, const char *kind, int native_code) {
  napi_value object = kind_object(env, kind);
  napi_value code;
  if (object == NULL) return NULL;
  if (strcmp(kind, "moved") == 0) return object;
  if (!check_napi(env, napi_create_int32(env, native_code, &code),
                  "failed to create native move code"))
    return NULL;
  if (!check_napi(env, napi_set_named_property(env, object, "nativeCode", code),
                  "failed to set native move code"))
    return NULL;
  return object;
}

static napi_value move_error_outcome(napi_env env, int error_code) {
  switch (error_code) {
    case EEXIST:
      return move_outcome(env, "destination-exists", error_code);
    case ENOENT:
    case ENOTDIR:
      return move_outcome(env, "path-missing", error_code);
    case EXDEV:
      return move_outcome(env, "cross-device", error_code);
    case ENOSYS:
      return move_outcome(env, "unsupported", error_code);
#if defined(ENOTSUP)
    case ENOTSUP:
      return move_outcome(env, "unsupported", error_code);
#endif
#if defined(EOPNOTSUPP) && (!defined(ENOTSUP) || EOPNOTSUPP != ENOTSUP)
    case EOPNOTSUPP:
      return move_outcome(env, "unsupported", error_code);
#endif
    default:
      return move_outcome(env, "failed", error_code);
  }
}

static napi_value rooted_landing_constructor(napi_env env, napi_callback_info info) {
  napi_value arguments[4];
  napi_value this_value;
  napi_value new_target;
  size_t argument_count = 4;
  char *source_root = NULL;
  char *worker_root = NULL;
  char *info_path = NULL;
  size_t source_length;
  size_t worker_length;
  size_t info_length;
  char *last_slash;
  char *info_parent = NULL;
  rooted_landing_host *host = NULL;

  if (!check_napi(env, napi_get_new_target(env, info, &new_target),
                  "failed to inspect RootedLandingHost construction"))
    return NULL;
  if (new_target == NULL) {
    napi_throw_type_error(env, NULL, "RootedLandingHost must be constructed with new");
    return NULL;
  }
  if (!check_napi(env,
                  napi_get_cb_info(env, info, &argument_count, arguments, &this_value, NULL),
                  "failed to read RootedLandingHost arguments"))
    return NULL;
  if (argument_count != 3) {
    napi_throw_type_error(env, NULL,
                          "RootedLandingHost expects sourceRoot, workerRoot, and infoExcludePath");
    return NULL;
  }
  if (!read_string(env, arguments[0], "sourceRoot", &source_root, &source_length) ||
      !read_string(env, arguments[1], "workerRoot", &worker_root, &worker_length) ||
      !read_string(env, arguments[2], "infoExcludePath", &info_path, &info_length))
    goto fail;
  if (!validate_absolute_path(env, source_root, source_length, "sourceRoot") ||
      !validate_absolute_path(env, worker_root, worker_length, "workerRoot") ||
      !validate_absolute_path(env, info_path, info_length, "infoExcludePath"))
    goto fail;

  last_slash = strrchr(info_path, '/');
  if (last_slash == NULL || last_slash[1] == '\0') {
    napi_throw_type_error(env, NULL, "infoExcludePath must name a file");
    goto fail;
  }
  if (last_slash == info_path) {
    info_parent = duplicate_bytes("/", 1);
  } else {
    info_parent = duplicate_bytes(info_path, (size_t)(last_slash - info_path));
  }
  if (info_parent == NULL) {
    napi_throw_error(env, NULL, "out of memory while capturing infoExcludePath");
    goto fail;
  }

  host = calloc(1, sizeof(*host));
  if (host == NULL) {
    napi_throw_error(env, NULL, "out of memory while creating RootedLandingHost");
    goto fail;
  }
  host->source_fd = -1;
  host->worker_fd = -1;
  host->info_parent_fd = -1;
  host->info_name = duplicate_bytes(last_slash + 1, strlen(last_slash + 1));
  if (host->info_name == NULL) {
    napi_throw_error(env, NULL, "out of memory while capturing infoExcludePath");
    goto fail;
  }
  host->source_fd = open_absolute_directory(source_root);
  if (host->source_fd < 0) {
    throw_errno(env, "failed to capture sourceRoot", errno);
    goto fail;
  }
  host->worker_fd = open_absolute_directory(worker_root);
  if (host->worker_fd < 0) {
    throw_errno(env, "failed to capture workerRoot", errno);
    goto fail;
  }
  host->info_parent_fd = open_absolute_directory(info_parent);
  if (host->info_parent_fd < 0) {
    throw_errno(env, "failed to capture infoExcludePath parent", errno);
    goto fail;
  }
  if (!check_napi(env, napi_wrap(env, this_value, host, finalize_host, NULL, NULL),
                  "failed to bind RootedLandingHost"))
    goto fail;

  free(source_root);
  free(worker_root);
  free(info_path);
  free(info_parent);
  return this_value;

fail:
  free(source_root);
  free(worker_root);
  free(info_path);
  free(info_parent);
  if (host != NULL) {
    close_host(host);
    free(host->info_name);
    free(host);
  }
  return NULL;
}

static napi_value inspect_path(napi_env env, napi_callback_info info) {
  napi_value arguments[3];
  napi_value this_value;
  rooted_landing_host *host;
  char *path = NULL;
  int root_fd;
  int parent_fd = -1;
  char *leaf = NULL;
  int result;
  struct stat stats;
  napi_value object;

  if (!callback_host(env, info, 2, arguments, &this_value, &host, false)) return NULL;
  if (!root_argument(env, arguments[0], host, &root_fd) ||
      !relative_argument(env, arguments[1], "path", &path))
    goto fail;
  result = open_parent_at(root_fd, path, &parent_fd, &leaf);
  if (result == ENOENT || result == ENOTDIR) {
    object = kind_object(env, "absent");
    goto done;
  }
  if (result != 0) {
    object = throw_errno(env, "failed to resolve inspected path", result);
    goto done;
  }
  if (fstatat(parent_fd, leaf, &stats, AT_SYMLINK_NOFOLLOW) < 0) {
    result = errno;
    if (result == ENOENT || result == ENOTDIR) {
      object = kind_object(env, "absent");
    } else {
      object = throw_errno(env, "failed to inspect path", result);
    }
    goto done;
  }

  if (S_ISDIR(stats.st_mode)) {
    object = kind_object(env, "directory");
  } else if (S_ISREG(stats.st_mode)) {
    int file_fd;
    unsigned char *bytes = NULL;
    size_t byte_length = 0;
    napi_value buffer;
    napi_value executable;
    do {
      file_fd = openat(parent_fd, leaf, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
    } while (file_fd < 0 && errno == EINTR);
    if (file_fd < 0) {
      object = throw_errno(env, "failed to open regular path", errno);
      goto done;
    }
    if (fstat(file_fd, &stats) < 0) {
      result = errno;
      close(file_fd);
      object = throw_errno(env, "failed to inspect opened regular path", result);
      goto done;
    }
    if (!S_ISREG(stats.st_mode)) {
      close(file_fd);
      object = throw_errno(env, "inspected path changed type", EINVAL);
      goto done;
    }
    result = read_all_fd(file_fd, &bytes, &byte_length);
    close(file_fd);
    if (result != 0) {
      object = throw_errno(env, "failed to read regular path", result);
      goto done;
    }
    object = kind_object(env, "regular");
    if (object == NULL ||
        !check_napi(env, napi_create_buffer_copy(env, byte_length, bytes, NULL, &buffer),
                    "failed to create regular path bytes") ||
        !check_napi(env, napi_set_named_property(env, object, "bytes", buffer),
                    "failed to set regular path bytes") ||
        !check_napi(env, napi_get_boolean(env, (stats.st_mode & 0111) != 0, &executable),
                    "failed to create executable flag") ||
        !check_napi(env, napi_set_named_property(env, object, "executable", executable),
                    "failed to set executable flag")) {
      free(bytes);
      object = NULL;
      goto done;
    }
    free(bytes);
  } else if (S_ISLNK(stats.st_mode)) {
    unsigned char *bytes = NULL;
    size_t byte_length = 0;
    napi_value buffer;
    result = read_link_at(parent_fd, leaf, &bytes, &byte_length);
    if (result != 0) {
      object = throw_errno(env, "failed to read symbolic link", result);
      goto done;
    }
    object = kind_object(env, "symlink");
    if (object == NULL ||
        !check_napi(env, napi_create_buffer_copy(env, byte_length, bytes, NULL, &buffer),
                    "failed to create symbolic link bytes") ||
        !check_napi(env, napi_set_named_property(env, object, "bytes", buffer),
                    "failed to set symbolic link bytes")) {
      free(bytes);
      object = NULL;
      goto done;
    }
    free(bytes);
  } else {
    object = kind_object(env, "unsupported");
    if (object != NULL &&
        !set_string_property(env, object, "detail", "unsupported host filesystem entry"))
      object = NULL;
  }
  goto done;

fail:
  object = NULL;
done:
  if (parent_fd >= 0) close(parent_fd);
  free(leaf);
  free(path);
  return object;
}

static napi_value manifest_leaf_paths(napi_env env, napi_callback_info info) {
  napi_value arguments[3];
  napi_value this_value;
  rooted_landing_host *host;
  char *path = NULL;
  int root_fd;
  int parent_fd = -1;
  char *leaf = NULL;
  int result;
  struct stat stats;
  string_list leaves = {0};
  napi_value array = NULL;
  size_t index;

  if (!callback_host(env, info, 2, arguments, &this_value, &host, false)) return NULL;
  if (!root_argument(env, arguments[0], host, &root_fd) ||
      !relative_argument(env, arguments[1], "path", &path))
    goto done;
  result = open_parent_at(root_fd, path, &parent_fd, &leaf);
  if (result == ENOENT || result == ENOTDIR) goto make_array;
  if (result != 0) {
    throw_errno(env, "failed to resolve manifest path", result);
    goto done;
  }
  if (fstatat(parent_fd, leaf, &stats, AT_SYMLINK_NOFOLLOW) < 0) {
    result = errno;
    if (result == ENOENT || result == ENOTDIR) goto make_array;
    throw_errno(env, "failed to inspect manifest path", result);
    goto done;
  }
  if (S_ISDIR(stats.st_mode)) {
    int directory_fd = open_directory_at(parent_fd, leaf);
    if (directory_fd < 0) {
      throw_errno(env, "failed to open manifest directory", errno);
      goto done;
    }
    result = collect_manifest_leaves(directory_fd, path, &leaves);
    close(directory_fd);
    if (result != 0) {
      throw_errno(env, "failed to traverse manifest directory", result);
      goto done;
    }
  } else {
    char *path_copy = duplicate_bytes(path, strlen(path));
    if (path_copy == NULL || string_list_push(&leaves, path_copy) != 0) {
      free(path_copy);
      napi_throw_error(env, NULL, "out of memory while collecting manifest paths");
      goto done;
    }
  }
  if (leaves.length > 1)
    qsort(leaves.items, leaves.length, sizeof(*leaves.items), compare_strings);

make_array:
  if (!check_napi(env, napi_create_array_with_length(env, leaves.length, &array),
                  "failed to create manifest path array")) {
    array = NULL;
    goto done;
  }
  for (index = 0; index < leaves.length; index += 1) {
    napi_value value;
    if (!check_napi(env,
                    napi_create_string_utf8(env, leaves.items[index], NAPI_AUTO_LENGTH, &value),
                    "failed to create manifest path") ||
        !check_napi(env, napi_set_element(env, array, (uint32_t)index, value),
                    "failed to set manifest path")) {
      array = NULL;
      goto done;
    }
  }

done:
  if (parent_fd >= 0) close(parent_fd);
  free(leaf);
  free(path);
  string_list_dispose(&leaves);
  return array;
}

static napi_value ensure_parent(napi_env env, napi_callback_info info) {
  napi_value arguments[2];
  napi_value this_value;
  rooted_landing_host *host;
  char *path = NULL;
  int result;

  if (!callback_host(env, info, 1, arguments, &this_value, &host, false)) return NULL;
  if (!relative_argument(env, arguments[0], "path", &path)) return NULL;
  result = ensure_parent_at(host->source_fd, path);
  free(path);
  if (result != 0) return throw_errno(env, "failed to ensure parent directories", result);
  return NULL;
}

static bool parse_mode(napi_env env, napi_value value, mode_t *mode, bool *symbolic_link) {
  char *text;
  size_t length;
  if (!read_string(env, value, "mode", &text, &length)) return false;
  *symbolic_link = false;
  if (length == 6 && memcmp(text, "100644", 6) == 0) {
    *mode = 0644;
  } else if (length == 6 && memcmp(text, "100755", 6) == 0) {
    *mode = 0755;
  } else if (length == 6 && memcmp(text, "120000", 6) == 0) {
    *mode = 0;
    *symbolic_link = true;
  } else {
    free(text);
    return throw_type(env, "mode must be 100644, 100755, or 120000");
  }
  free(text);
  return true;
}

static napi_value materialize_target(napi_env env, napi_callback_info info) {
  napi_value arguments[4];
  napi_value this_value;
  rooted_landing_host *host;
  char *source = NULL;
  char *destination = NULL;
  mode_t mode;
  bool symbolic_link;
  int source_parent = -1;
  int destination_parent = -1;
  char *source_leaf = NULL;
  char *destination_leaf = NULL;
  int result;

  if (!callback_host(env, info, 3, arguments, &this_value, &host, false)) return NULL;
  if (!relative_argument(env, arguments[0], "source", &source) ||
      !relative_argument(env, arguments[1], "destination", &destination) ||
      !parse_mode(env, arguments[2], &mode, &symbolic_link))
    goto done;
  result = open_parent_at(host->worker_fd, source, &source_parent, &source_leaf);
  if (result != 0) {
    throw_errno(env, "failed to resolve materialization source", result);
    goto done;
  }
  result = open_parent_at(host->source_fd, destination, &destination_parent, &destination_leaf);
  if (result != 0) {
    throw_errno(env, "failed to resolve materialization destination", result);
    goto done;
  }

  if (symbolic_link) {
    unsigned char *target = NULL;
    size_t target_length = 0;
    char *target_text;
    result = read_link_at(source_parent, source_leaf, &target, &target_length);
    if (result != 0) {
      throw_errno(env, "failed to capture materialization symlink", result);
      goto done;
    }
    target_text = duplicate_bytes((const char *)target, target_length);
    free(target);
    if (target_text == NULL) {
      napi_throw_error(env, NULL, "out of memory while materializing symlink");
      goto done;
    }
    if (symlinkat(target_text, destination_parent, destination_leaf) < 0) {
      result = errno;
      free(target_text);
      throw_errno(env, "failed to materialize symlink", result);
      goto done;
    }
    free(target_text);
  } else {
    int source_fd;
    int destination_fd;
    unsigned char buffer[64 * 1024];
    struct stat stats;
    do {
      source_fd =
          openat(source_parent, source_leaf, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
    } while (source_fd < 0 && errno == EINTR);
    if (source_fd < 0) {
      throw_errno(env, "failed to open materialization source", errno);
      goto done;
    }
    if (fstat(source_fd, &stats) < 0) {
      result = errno;
      close(source_fd);
      throw_errno(env, "failed to inspect materialization source", result);
      goto done;
    }
    if (!S_ISREG(stats.st_mode)) {
      close(source_fd);
      throw_errno(env, "materialization source is not a regular file", EINVAL);
      goto done;
    }
    do {
      destination_fd = openat(destination_parent, destination_leaf,
                              O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    } while (destination_fd < 0 && errno == EINTR);
    if (destination_fd < 0) {
      result = errno;
      close(source_fd);
      throw_errno(env, "failed to create materialization destination", result);
      goto done;
    }
    result = 0;
    for (;;) {
      ssize_t read_count;
      do {
        read_count = read(source_fd, buffer, sizeof(buffer));
      } while (read_count < 0 && errno == EINTR);
      if (read_count < 0) {
        result = errno;
        break;
      }
      if (read_count == 0) break;
      result = write_all(destination_fd, buffer, (size_t)read_count);
      if (result != 0) break;
    }
    if (result == 0 && fchmod(destination_fd, mode) < 0) result = errno;
    if (result == 0 && fsync(destination_fd) < 0) result = errno;
    if (close(destination_fd) < 0 && result == 0) result = errno;
    close(source_fd);
    if (result != 0) {
      (void)unlinkat(destination_parent, destination_leaf, 0);
      throw_errno(env, "failed to materialize regular file", result);
      goto done;
    }
  }

done:
  if (source_parent >= 0) close(source_parent);
  if (destination_parent >= 0) close(destination_parent);
  free(source_leaf);
  free(destination_leaf);
  free(source);
  free(destination);
  return NULL;
}

static napi_value move_path(napi_env env, napi_callback_info info) {
  napi_value arguments[3];
  napi_value this_value;
  rooted_landing_host *host;
  char *source = NULL;
  char *destination = NULL;
  int source_parent = -1;
  int destination_parent = -1;
  char *source_leaf = NULL;
  char *destination_leaf = NULL;
  int result;
  napi_value outcome = NULL;

  if (!callback_host(env, info, 2, arguments, &this_value, &host, false)) return NULL;
  if (!relative_argument(env, arguments[0], "source", &source) ||
      !relative_argument(env, arguments[1], "destination", &destination))
    goto done;
  result = open_parent_at(host->source_fd, source, &source_parent, &source_leaf);
  if (result != 0) {
    outcome = move_error_outcome(env, result);
    goto done;
  }
  result = open_parent_at(host->source_fd, destination, &destination_parent, &destination_leaf);
  if (result != 0) {
    outcome = move_error_outcome(env, result);
    goto done;
  }
#if defined(__APPLE__)
  result = renameatx_np(source_parent, source_leaf, destination_parent, destination_leaf,
                        RENAME_EXCL);
#else
  result = renameat2(source_parent, source_leaf, destination_parent, destination_leaf,
                     RENAME_NOREPLACE);
#endif
  outcome = result == 0 ? move_outcome(env, "moved", 0) : move_error_outcome(env, errno);

done:
  if (source_parent >= 0) close(source_parent);
  if (destination_parent >= 0) close(destination_parent);
  free(source_leaf);
  free(destination_leaf);
  free(source);
  free(destination);
  return outcome;
}

static napi_value remove_path(napi_env env, napi_callback_info info) {
  napi_value arguments[3];
  napi_value this_value;
  rooted_landing_host *host;
  char *path = NULL;
  bool recursive;
  int parent_fd = -1;
  char *leaf = NULL;
  int result;
  napi_valuetype recursive_type;

  if (!callback_host(env, info, 2, arguments, &this_value, &host, false)) return NULL;
  if (!relative_argument(env, arguments[0], "path", &path)) goto done;
  if (!check_napi(env, napi_typeof(env, arguments[1], &recursive_type),
                  "failed to inspect recursive argument"))
    goto done;
  if (recursive_type != napi_boolean) {
    throw_type(env, "recursive must be a boolean");
    goto done;
  }
  if (!check_napi(env, napi_get_value_bool(env, arguments[1], &recursive),
                  "failed to read recursive argument"))
    goto done;
  result = open_parent_at(host->source_fd, path, &parent_fd, &leaf);
  if (result == ENOENT || result == ENOTDIR) goto done;
  if (result != 0) {
    throw_errno(env, "failed to resolve removal path", result);
    goto done;
  }
  result = remove_entry_at(parent_fd, leaf, recursive);
  if (result != 0) throw_errno(env, "failed to remove path", result);

done:
  if (parent_fd >= 0) close(parent_fd);
  free(leaf);
  free(path);
  return NULL;
}

static napi_value remove_empty_parents(napi_env env, napi_callback_info info) {
  napi_value arguments[2];
  napi_value this_value;
  rooted_landing_host *host;
  char *path = NULL;
  char *cursor;

  if (!callback_host(env, info, 1, arguments, &this_value, &host, false)) return NULL;
  if (!relative_argument(env, arguments[0], "path", &path)) return NULL;
  cursor = strrchr(path, '/');
  while (cursor != NULL) {
    int parent_fd = -1;
    char *leaf = NULL;
    int result;
    *cursor = '\0';
    result = open_parent_at(host->source_fd, path, &parent_fd, &leaf);
    if (result == 0) {
      if (unlinkat(parent_fd, leaf, AT_REMOVEDIR) < 0) result = errno;
      close(parent_fd);
      free(leaf);
    }
    if (result == ENOTEMPTY || result == EEXIST || result == ENOTDIR) break;
    if (result != 0 && result != ENOENT) {
      throw_errno(env, "failed to remove empty parent", result);
      free(path);
      return NULL;
    }
    cursor = strrchr(path, '/');
  }
  free(path);
  return NULL;
}

static napi_value string_value(napi_env env, const char *value) {
  napi_value result;
  if (!check_napi(env, napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &result),
                  "failed to create string result"))
    return NULL;
  return result;
}

static napi_value remove_empty_directory(napi_env env, napi_callback_info info) {
  napi_value arguments[2];
  napi_value this_value;
  rooted_landing_host *host;
  char *path = NULL;
  int parent_fd = -1;
  char *leaf = NULL;
  int result;
  struct stat stats;
  napi_value outcome = NULL;

  if (!callback_host(env, info, 1, arguments, &this_value, &host, false)) return NULL;
  if (!relative_argument(env, arguments[0], "path", &path)) goto done;
  result = open_parent_at(host->source_fd, path, &parent_fd, &leaf);
  if (result == ENOENT || result == ENOTDIR) {
    outcome = string_value(env, "absent");
    goto done;
  }
  if (result != 0) {
    outcome = throw_errno(env, "failed to resolve empty directory", result);
    goto done;
  }
  if (parent_fd < 0 || leaf == NULL) {
    outcome = throw_errno(env, "failed to resolve empty directory", EIO);
    goto done;
  }
  if (fstatat(parent_fd, leaf, &stats, AT_SYMLINK_NOFOLLOW) < 0) {
    result = errno;
    outcome = result == ENOENT ? string_value(env, "absent")
                               : throw_errno(env, "failed to inspect empty directory", result);
    goto done;
  }
  if (!S_ISDIR(stats.st_mode)) {
    outcome = string_value(env, "not-directory");
    goto done;
  }
  if (unlinkat(parent_fd, leaf, AT_REMOVEDIR) == 0) {
    outcome = string_value(env, "removed");
    goto done;
  }
  result = errno;
  if (result == ENOENT) {
    outcome = string_value(env, "absent");
  } else if (result == ENOTEMPTY || result == EEXIST) {
    outcome = string_value(env, "not-empty");
  } else if (result == ENOTDIR) {
    outcome = string_value(env, "not-directory");
  } else {
    outcome = throw_errno(env, "failed to remove empty directory", result);
  }

done:
  if (parent_fd >= 0) close(parent_fd);
  free(leaf);
  free(path);
  return outcome;
}

static bool line_matches(const unsigned char *bytes, size_t start, size_t end, const char *rule,
                         size_t rule_length) {
  if (end > start && bytes[end - 1] == '\r') end -= 1;
  return end - start == rule_length && memcmp(bytes + start, rule, rule_length) == 0;
}

static bool contains_rule(const unsigned char *bytes, size_t length, const char *rule,
                          size_t rule_length) {
  size_t start = 0;
  size_t index;
  for (index = 0; index <= length; index += 1) {
    if (index == length || bytes[index] == '\n') {
      if (line_matches(bytes, start, index, rule, rule_length)) return true;
      start = index + 1;
    }
  }
  return false;
}

static napi_value exclusion_status(napi_env env, const char *status) {
  napi_value object;
  if (!check_napi(env, napi_create_object(env, &object), "failed to create exclusion result"))
    return NULL;
  if (!set_string_property(env, object, "status", status)) return NULL;
  return object;
}

static napi_value ensure_info_exclude_rule(napi_env env, napi_callback_info info) {
  napi_value arguments[2];
  napi_value this_value;
  rooted_landing_host *host;
  char *rule = NULL;
  size_t rule_length;
  int fd = -1;
  unsigned char *bytes = NULL;
  size_t length = 0;
  int result = 0;
  bool found = false;
  napi_value outcome = NULL;

  if (!callback_host(env, info, 1, arguments, &this_value, &host, false)) return NULL;
  if (!read_string(env, arguments[0], "rule", &rule, &rule_length)) goto done;
  if (rule_length == 0 || memchr(rule, '\n', rule_length) != NULL ||
      memchr(rule, '\r', rule_length) != NULL) {
    throw_type(env, "rule must be one non-empty line");
    goto done;
  }
  do {
    fd = openat(host->info_parent_fd, host->info_name,
                O_RDWR | O_CREAT | O_APPEND | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC, 0666);
  } while (fd < 0 && errno == EINTR);
  if (fd < 0) {
    throw_errno(env, "failed to open info/exclude", errno);
    goto done;
  }
  {
    struct stat stats;
    if (fstat(fd, &stats) < 0) {
      throw_errno(env, "failed to inspect info/exclude", errno);
      goto done;
    }
    if (!S_ISREG(stats.st_mode)) {
      throw_errno(env, "info/exclude is not a regular file", EINVAL);
      goto done;
    }
  }
  do {
    result = flock(fd, LOCK_EX);
  } while (result < 0 && errno == EINTR);
  if (result < 0) {
    throw_errno(env, "failed to lock info/exclude", errno);
    goto done;
  }
  if (lseek(fd, 0, SEEK_SET) < 0) {
    result = errno;
    goto unlock;
  }
  result = read_all_fd(fd, &bytes, &length);
  if (result != 0) goto unlock;
  found = contains_rule(bytes, length, rule, rule_length);
  if (!found) {
    static const unsigned char newline = '\n';
    if (length > 0 && bytes[length - 1] != '\n') result = write_all(fd, &newline, 1);
    if (result == 0) result = write_all(fd, (const unsigned char *)rule, rule_length);
    if (result == 0) result = write_all(fd, &newline, 1);
    if (result == 0 && fsync(fd) < 0) result = errno;
  }

unlock:
  {
    int unlock_result;
    do {
      unlock_result = flock(fd, LOCK_UN);
    } while (unlock_result < 0 && errno == EINTR);
    if (unlock_result < 0 && result == 0) result = errno;
  }
  if (result != 0) {
    throw_errno(env, "failed to update info/exclude", result);
    goto done;
  }
  outcome = exclusion_status(env, found ? "already-present" : "installed");

done:
  if (fd >= 0) close(fd);
  free(bytes);
  free(rule);
  return outcome;
}

static napi_value close_rooted_landing_host(napi_env env, napi_callback_info info) {
  napi_value arguments[1];
  napi_value this_value;
  rooted_landing_host *host;
  if (!callback_host(env, info, 0, arguments, &this_value, &host, true)) return NULL;
  close_host(host);
  return NULL;
}

NAPI_MODULE_INIT() {
  napi_property_descriptor methods[] = {
      {"inspect", NULL, inspect_path, NULL, NULL, NULL, napi_default, NULL},
      {"manifestLeafPaths", NULL, manifest_leaf_paths, NULL, NULL, NULL, napi_default, NULL},
      {"ensureParent", NULL, ensure_parent, NULL, NULL, NULL, napi_default, NULL},
      {"materializeTarget", NULL, materialize_target, NULL, NULL, NULL, napi_default, NULL},
      {"move", NULL, move_path, NULL, NULL, NULL, napi_default, NULL},
      {"remove", NULL, remove_path, NULL, NULL, NULL, napi_default, NULL},
      {"removeEmptyParents", NULL, remove_empty_parents, NULL, NULL, NULL, napi_default, NULL},
      {"removeEmptyDirectory", NULL, remove_empty_directory, NULL, NULL, NULL, napi_default, NULL},
      {"ensureInfoExcludeRule", NULL, ensure_info_exclude_rule, NULL, NULL, NULL, napi_default,
       NULL},
      {"close", NULL, close_rooted_landing_host, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_value constructor;
  if (!check_napi(env,
                  napi_define_class(env, "RootedLandingHost", NAPI_AUTO_LENGTH,
                                    rooted_landing_constructor, NULL,
                                    sizeof(methods) / sizeof(methods[0]), methods, &constructor),
                  "failed to define RootedLandingHost"))
    return NULL;
  if (!check_napi(env, napi_set_named_property(env, exports, "RootedLandingHost", constructor),
                  "failed to export RootedLandingHost"))
    return NULL;
  return exports;
}

#else
#error Unsupported platform
#endif
