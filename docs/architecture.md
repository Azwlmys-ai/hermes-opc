# OPC Architecture

OPC v0.1 is a controlled agent runtime foundation. The core flow is intentionally simple:

```text
Agent
  |
  v
Kernel
  |
  v
WAITING_APPROVAL
  |
  v
Verification
  |
  v
Constitution
  |
  v
Patch Apply
```

## Agent

Agents produce task output and proposed patches. In v0.1, the important architectural rule is that agent output is not automatically trusted.

## Kernel

The kernel accepts tasks, tracks state, stores task detail, and moves completed proposals into the approval path. The kernel is the coordinator, not a direct file-editing escape hatch.

## WAITING_APPROVAL

`WAITING_APPROVAL` is the boundary between agent proposal and file mutation. A task must pass through this state before approval can attempt verification and patch application.

## Verification Checks

Verification checks are the first safety layer before patch application. They validate the proposed change through project checks such as typecheck, smoke tests, and patch safety checks.

If verification fails, the patch must not be applied.

## Constitution Rules

Constitution rules are policy constraints over the proposed change. They are used to keep work inside allowed boundaries and prevent unsafe or out-of-scope modifications.

Constitution checks are part of the approval discipline. They are not optional documentation; they are runtime policy.

## Sandbox Boundaries

Workspace and runtime operations are expected to remain inside configured boundaries. The sandbox is part of the trust model.

Direct file I/O fallback is forbidden because it bypasses:

- the approval gate
- verification checks
- constitution rules
- sandbox boundaries
- auditability of the patch path

## MCP Boundary

The MCP server exposes controlled tools to external clients. The server protocol and production stdio entrypoint have passed smoke validation, but external client attachment remains client-dependent.
