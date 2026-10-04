<script lang="ts">
const sections = [
  {
    href: "/admin/activity",
    label: "Activity",
    blurb: "See who is playing what, and follow store jobs.",
  },
  {
    href: "/admin/libraries",
    label: "Libraries",
    blurb:
      "Add, rename, scan and delete media libraries, and choose the Versions each one stores.",
  },
  {
    href: "/admin/users",
    label: "Users",
    blurb:
      "Create accounts and invites, and manage sessions, groups and access per user.",
  },
  {
    href: "/admin/groups",
    label: "Groups",
    blurb: "Create custom groups and edit the permissions they grant.",
  },
  {
    href: "/admin/plugins",
    label: "Plugins",
    blurb:
      "Install plugins from a source or a registry, enable them, and switch their file access.",
  },
  {
    href: "/admin/settings",
    label: "Settings",
    blurb:
      "Set trusted proxies, the bitrate cap, the store window and provider keys, toggle artwork auth, and check the artwork store and OIDC.",
  },
];
</script>

<h2>Administration</h2>

{#each sections as section (section.href)}
  <section>
    <h3><a href={section.href}>{section.label}</a></h3>
    <p class="muted">{section.blurb}</p>
  </section>
{/each}
