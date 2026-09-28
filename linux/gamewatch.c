/*============================================================================
 * gamewatch.exe - the dialog half of lib/launcher.js, for running under Wine.
 *
 *   wine gamewatch.exe <game.exe> [game args...]
 *
 * Only a Windows program can see a Wine program's dialogs, so on Linux the
 * launcher starts this instead of the game. It starts the game, clears GM8's
 * modal dialogs exactly as launcher.js does on Windows, and prints what they
 * said in the launcher log's own format ("  E| ...", "  M| ...", "dismissed
 * ..."), which the launcher timestamps and the runner reads back.
 *
 * The game goes in a job object that is killed when this process ends, so
 * stopping gamewatch stops the game. Exits with the game's exit code.
 *
 * Built in linux/Dockerfile with mingw:
 *   i686-w64-mingw32-gcc -O2 -o gamewatch.exe gamewatch.c -luser32
 *===========================================================================*/
#include <windows.h>
#include <stdio.h>
#include <string.h>

/* The three windows that can stop the game, and the button to press in each.
 * See DIALOGS in lib/launcher.js. */
typedef struct { const char *cls, *button, *press, *mark; } Spec;
static const Spec SPECS[] = {
  { "TErrorForm", "TBitBtn", "Ignore", "E" },
  { "TMessageForm", "TButton", NULL, "M" },
  { "#32770", "Button", NULL, "M" },
};

static DWORD gamePid;
static HWND found[64];
static int nfound, said;
static const Spec *spec;
static HWND target;

static int isButton(const char *cls) {
  return !strcmp(cls, "TBitBtn") || !strcmp(cls, "TButton") || !strcmp(cls, "Button") || !strcmp(cls, "TSpeedButton");
}

/* Print a control's text a line at a time. Sent with a timeout: the dialog's
 * owner may be the thing that has stopped answering. */
static void printText(HWND h) {
  static char buf[16384];
  DWORD_PTR n = 0;
  if (!SendMessageTimeoutA(h, WM_GETTEXT, sizeof buf, (LPARAM)buf, SMTO_ABORTIFHUNG, 500, &n)) n = 0;
  buf[n < sizeof buf ? n : sizeof buf - 1] = 0;
  for (char *line = strtok(buf, "\r\n"); line; line = strtok(NULL, "\r\n")) {
    while (*line == ' ') line++;
    if (*line) {
      printf("  %s| %s\n", spec->mark, line);
      said++;
    }
  }
}

/* EnumChildWindows walks every descendant, so text nested in a panel is found
 * without recursing by hand. */
static BOOL CALLBACK onChild(HWND h, LPARAM lp) {
  char cls[64], text[128];
  (void)lp;
  GetClassNameA(h, cls, sizeof cls);
  if (!strcmp(cls, spec->button)) {
    GetWindowTextA(h, text, sizeof text);
    if (!target && (!spec->press || strstr(text, spec->press))) target = h;
  } else if (!isButton(cls)) {
    printText(h);
  }
  return TRUE;
}

/* These forms exist from startup and are merely hidden: only visible ones count. */
static BOOL CALLBACK onTop(HWND h, LPARAM lp) {
  char cls[64];
  DWORD pid = 0;
  (void)lp;
  GetWindowThreadProcessId(h, &pid);
  if (pid != gamePid || !IsWindowVisible(h)) return TRUE;
  GetClassNameA(h, cls, sizeof cls);
  if (!strcmp(cls, spec->cls) && nfound < 64) found[nfound++] = h;
  return TRUE;
}

int main(void) {
  setvbuf(stdout, NULL, _IONBF, 0);

  /* Everything after our own name is the game's command line, as Wine built it. */
  char *cmd = GetCommandLineA();
  if (*cmd == '"') {
    cmd = strchr(cmd + 1, '"');
    cmd = cmd ? cmd + 1 : "";
  } else {
    while (*cmd && *cmd != ' ') cmd++;
  }
  while (*cmd == ' ') cmd++;
  if (!*cmd) {
    printf("FAIL: usage: gamewatch.exe <game.exe> [args...]\n");
    return 1;
  }

  HANDLE job = CreateJobObjectA(NULL, NULL);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION lim;
  memset(&lim, 0, sizeof lim);
  lim.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  SetInformationJobObject(job, JobObjectExtendedLimitInformation, &lim, sizeof lim);

  /* Suspended until it is in the job, so it cannot outlive us even briefly. */
  STARTUPINFOA si;
  PROCESS_INFORMATION pi;
  memset(&si, 0, sizeof si);
  si.cb = sizeof si;
  if (!CreateProcessA(NULL, cmd, NULL, NULL, FALSE, CREATE_SUSPENDED, NULL, NULL, &si, &pi)) {
    printf("FAIL: could not start the game (error %lu)\n", GetLastError());
    return 1;
  }
  AssignProcessToJobObject(job, pi.hProcess);
  ResumeThread(pi.hThread);
  gamePid = pi.dwProcessId;
  printf("windows pid %lu\n", gamePid);

  int dismissed = 0;
  while (WaitForSingleObject(pi.hProcess, 250) == WAIT_TIMEOUT) {
    for (int d = 0; d < 3; d++) {
      spec = &SPECS[d];
      nfound = 0;
      EnumWindows(onTop, 0);
      for (int i = 0; i < nfound; i++) {
        char title[256];
        GetWindowTextA(found[i], title, sizeof title);
        const char *name = *title ? title : spec->cls;

        /* Read before clicking: once the box is gone, so is its text. */
        target = NULL;
        said = 0;
        EnumChildWindows(found[i], onChild, 0);
        if (!said) printf("  %s| (dialog had no readable text)\n", spec->mark);

        dismissed++;
        if (target) {
          PostMessageA(target, BM_CLICK, 0, 0);
          if (spec->press) printf("dismissed %s (pressed %s) - %d so far\n", name, spec->press, dismissed);
          else printf("dismissed %s - %d so far\n", name, dismissed);
        } else {
          /* A painted OK with no control behind it: WM_CLOSE unblocks it the
           * same way. Marked M! as launcher.js does. */
          PostMessageA(found[i], WM_CLOSE, 0, 0);
          printf("  M!| forced closed (no %s child to click)\n", spec->button);
          printf("dismissed %s (forced closed) - %d so far\n", name, dismissed);
        }
      }
    }
  }

  DWORD code = 0;
  GetExitCodeProcess(pi.hProcess, &code);
  return (int)code;
}
