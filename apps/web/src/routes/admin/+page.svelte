<script lang="ts">
const sections = [
  {
    href: "/admin/libraries",
    label: "Libraries",
    blurb: "Add media folders, rename them and follow each scan.",
  },
  {
    href: "/admin/users",
    label: "Users",
    blurb: "Create accounts, set group membership and tune per-user access.",
  },
  {
    href: "/admin/groups",
    label: "Groups",
    blurb: "Create custom groups and choose the permissions they grant.",
  },
  {
    href: "/admin/settings",
    label: "Settings",
    blurb: "Set trusted proxies, the artwork toggle and provider keys.",
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
