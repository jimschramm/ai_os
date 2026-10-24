/**
 * Directory under the user home when neither `T3CODE_HOME` nor `--base-dir`
 * is set. An explicit value still wins. Worktree dev state stays `<worktree>/.t3`.
 */
export const AI_OS_HOME_DIRECTORY_NAME = ".ai_os-home";

/**
 * T3 Code's own home. ai_os does not use it, and maintenance scripts refuse
 * to write it. The ai_os default is `AI_OS_HOME_DIRECTORY_NAME`.
 */
export const T3_CODE_HOME_DIRECTORY_NAME = ".t3";
