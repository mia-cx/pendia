<script lang="ts">
const sections = [
  {
    href: "/admin/libraries",
    label: "Libraries",
    blurb: "Add, rename, scan and delete media libraries.",
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
    href: "/admin/settings",
    label: "Settings",
    blurb:
      "Set trusted proxies and provider keys, toggle artwork auth and check OIDC.",
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
