import { lazy, Suspense, type ComponentProps, type ReactNode } from "react";
import { LazyViewBoundary } from "./lazy-boundary";

/**
 * Screens the first paint does not need.
 *
 * The chat shell imports this module, not the screens. Each `import()` stays out
 * of the initial chunk until the view actually mounts. Static markup tests replace
 * the module, because `renderToStaticMarkup` cannot wait on Suspense.
 */
const ProjectListLazy = lazy(() =>
  import("./project-list").then((mod) => ({ default: mod.ProjectList })),
);
const RepoViewLazy = lazy(() =>
  import("./repo-view").then((mod) => ({ default: mod.RepoView })),
);
const InboxViewLazy = lazy(() =>
  import("./inbox-view").then((mod) => ({ default: mod.InboxView })),
);
const ParallelViewLazy = lazy(() =>
  import("./parallel-view").then((mod) => ({ default: mod.ParallelView })),
);
const SettingsDialogLazy = lazy(() =>
  import("./settings").then((mod) => ({ default: mod.SettingsDialog })),
);

function whenMounted(children: ReactNode) {
  return (
    <LazyViewBoundary>
      <Suspense fallback={null}>{children}</Suspense>
    </LazyViewBoundary>
  );
}

export function DeferredProjectList(
  props: ComponentProps<typeof import("./project-list").ProjectList>,
) {
  return whenMounted(<ProjectListLazy {...props} />);
}

export function DeferredRepoView(
  props: ComponentProps<typeof import("./repo-view").RepoView>,
) {
  return whenMounted(<RepoViewLazy {...props} />);
}

export function DeferredInboxView(
  props: ComponentProps<typeof import("./inbox-view").InboxView>,
) {
  return whenMounted(<InboxViewLazy {...props} />);
}

export function DeferredParallelView(
  props: ComponentProps<typeof import("./parallel-view").ParallelView>,
) {
  return whenMounted(<ParallelViewLazy {...props} />);
}

export function DeferredSettingsDialog(
  props: ComponentProps<typeof import("./settings").SettingsDialog>,
) {
  return whenMounted(<SettingsDialogLazy {...props} />);
}
