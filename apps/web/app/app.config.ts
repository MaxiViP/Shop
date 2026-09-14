export default defineAppConfig({
  ui: {
    container: {
      base: "min-w-0 px-(--page-x) sm:px-(--page-x) lg:px-(--page-x)",
    },
    input: {
      slots: {
        root: "w-full min-w-0",
        base: "min-w-0 min-h-(--touch-target)",
      },
    },
    textarea: {
      slots: {
        root: "w-full min-w-0",
        base: "min-w-0 min-h-(--touch-target) resize-y",
      },
    },
    select: {
      slots: {
        base: "w-full min-w-0 min-h-(--touch-target)",
        item: "min-h-(--touch-target) items-center",
        itemLabel: "whitespace-normal [overflow-wrap:anywhere]",
      },
    },
    formField: {
      slots: {
        root: "min-w-0 max-w-full",
        labelWrapper: "flex-wrap items-start",
        container: "min-w-0",
        label: "leading-relaxed [overflow-wrap:anywhere]",
        description: "leading-relaxed [overflow-wrap:anywhere]",
        error: "leading-relaxed [overflow-wrap:anywhere]",
        help: "leading-relaxed [overflow-wrap:anywhere]",
      },
    },
    switch: {
      slots: {
        root: "min-w-0 min-h-(--touch-target) items-center",
        label: "flex min-h-(--touch-target) items-center",
      },
    },
    button: {
      slots: {
        base: "min-h-(--touch-target) min-w-(--touch-target) max-w-full justify-center [overflow-wrap:anywhere]",
        label: "whitespace-normal",
      },
    },
    card: {
      slots: {
        root: "min-w-0",
        header: "p-(--card-padding) sm:px-(--card-padding)",
        body: "min-w-0 p-(--card-padding) sm:p-(--card-padding)",
        footer: "p-(--card-padding) sm:px-(--card-padding)",
      },
    },
  },
});
