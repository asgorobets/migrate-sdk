import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  linkSync,
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Schema } from "effect";
import { MigrateServerInstanceId } from "../../protocol/index.ts";

const windowsPrivateDirectoryScript = `
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [Security.Principal.SecurityIdentifier]::new("S-1-5-18")
$administratorsSid = [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
$root = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if ([String]::IsNullOrWhiteSpace($root)) {
  throw "Windows did not provide a per-user LocalApplicationData directory"
}
$rootItem = Get-Item -LiteralPath $root -Force
if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw "The per-user LocalApplicationData directory is a reparse point"
}
$rootOwner = [IO.Directory]::GetAccessControl($root).GetOwner([Security.Principal.SecurityIdentifier])
if ($rootOwner.Value -ne $userSid.Value -and $rootOwner.Value -ne $systemSid.Value -and $rootOwner.Value -ne $administratorsSid.Value) {
  throw "The LocalApplicationData directory has an untrusted owner"
}

$directory = [IO.Path]::Combine($rootItem.FullName, "migrate-sdk-ipc")
[IO.Directory]::CreateDirectory($directory) | Out-Null
$directoryItem = Get-Item -LiteralPath $directory -Force
if (-not $directoryItem.PSIsContainer -or ($directoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw "The Migrate SDK endpoint directory is not a private directory"
}
if ($directoryItem.Parent.FullName -ne $rootItem.FullName) {
  throw "The Migrate SDK endpoint directory escaped LocalApplicationData"
}

$inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
$propagation = [Security.AccessControl.PropagationFlags]::None
$allow = [Security.AccessControl.AccessControlType]::Allow
$fullControl = [Security.AccessControl.FileSystemRights]::FullControl
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($userSid)
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($userSid, $fullControl, $inheritance, $propagation, $allow))
if ($userSid.Value -ne $systemSid.Value) {
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($systemSid, $fullControl, $inheritance, $propagation, $allow))
}
[IO.Directory]::SetAccessControl($directory, $acl)

$verified = [IO.Directory]::GetAccessControl($directory)
$verifiedItem = Get-Item -LiteralPath $directory -Force
if (($verifiedItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw "The Migrate SDK endpoint directory became a reparse point"
}
if ($verifiedItem.Parent.FullName -ne $rootItem.FullName) {
  throw "The verified Migrate SDK endpoint directory escaped LocalApplicationData"
}
if ($verified.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $userSid.Value) {
  throw "The current user does not own the Migrate SDK endpoint directory"
}
if (-not $verified.AreAccessRulesProtected) {
  throw "Migrate SDK endpoint directory still inherits access rules"
}
$hasUserRule = $false
$rules = @($verified.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))
foreach ($rule in $rules) {
  $sid = $rule.IdentityReference.Value
  if ($rule.AccessControlType -ne $allow -or ($sid -ne $userSid.Value -and $sid -ne $systemSid.Value)) {
    throw "Migrate SDK endpoint directory has an unexpected access rule"
  }
  if (($rule.FileSystemRights -band $fullControl) -ne $fullControl) {
    throw "Migrate SDK endpoint directory access is too narrow"
  }
  if ($sid -eq $userSid.Value) {
    $hasUserRule = $true
  }
}
if (-not $hasUserRule) {
  throw "Migrate SDK endpoint directory does not grant the current user access"
}
[Console]::Out.Write($directory)
`;
const windowsPrivateDirectoryCommand = Buffer.from(
  windowsPrivateDirectoryScript,
  "utf16le"
).toString("base64");
let hardenedWindowsPrivateDirectory: string | undefined;

const validateWindowsPrivateDirectoryEntries = (directory: string): void => {
  const root = dirname(directory);
  const rootEntry = lstatSync(root);
  const directoryEntry = lstatSync(directory);

  if (
    !rootEntry.isDirectory() ||
    rootEntry.isSymbolicLink() ||
    !directoryEntry.isDirectory() ||
    directoryEntry.isSymbolicLink()
  ) {
    throw new Error(
      "Windows Migrate Server endpoint directory is no longer private"
    );
  }
};

export const ensurePrivateWindowsLocalMigrateServerDirectory = (): string => {
  if (hardenedWindowsPrivateDirectory !== undefined) {
    validateWindowsPrivateDirectoryEntries(hardenedWindowsPrivateDirectory);
    return hardenedWindowsPrivateDirectory;
  }

  const directory = resolve(
    execFileSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        windowsPrivateDirectoryCommand,
      ],
      {
        encoding: "utf8",
        windowsHide: true,
      }
    ).trim()
  );

  validateWindowsPrivateDirectoryEntries(directory);
  hardenedWindowsPrivateDirectory = directory;
  return directory;
};

export const localMigrateServerLoopbackHost = "127.0.0.1";
export const LocalMigrateServerTcpDiscovery = Schema.Struct({
  authToken: Schema.NonEmptyString,
  host: Schema.Literal(localMigrateServerLoopbackHost),
  instanceId: MigrateServerInstanceId,
  pid: Schema.Int,
  port: Schema.Int,
});
export const LocalMigrateServerTcpDiscoveryJson = Schema.fromJsonString(
  LocalMigrateServerTcpDiscovery
);

export interface LocalMigrateServerEndpointInput {
  readonly buildId?: string;
  readonly configPath?: string;
  readonly cwd: string;
}

export interface LocalMigrateServerEndpointEnvironment {
  readonly platform: NodeJS.Platform;
  readonly sdkVersion: string;
  readonly serverIdentity?: string;
  readonly tempDirectory: string;
  readonly user: number | string;
}

export interface LocalMigrateServerPosixEndpointIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

export const readLocalMigrateServerPosixEndpointIdentity = (
  endpoint: string
): LocalMigrateServerPosixEndpointIdentity | undefined => {
  try {
    const stats = lstatSync(endpoint, { bigint: true });
    return { device: stats.dev, inode: stats.ino };
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return;
    }
    throw cause;
  }
};

const samePosixEndpointIdentity = (
  first: LocalMigrateServerPosixEndpointIdentity,
  second: LocalMigrateServerPosixEndpointIdentity
): boolean => first.device === second.device && first.inode === second.inode;

export interface LocalMigrateServerEndpointClaim {
  readonly claimedPath: string;
  readonly endpoint: string;
  readonly restore: boolean;
  readonly verification:
    | { readonly failed: false }
    | { readonly cause: unknown; readonly failed: true };
}

export const claimLocalMigrateServerEndpoint = (
  endpoint: string,
  ownsClaim: (claimedPath: string) => boolean
): LocalMigrateServerEndpointClaim | undefined => {
  const claimedPath = `${endpoint}.${process.pid}.${randomUUID()}.claim`;
  try {
    renameSync(endpoint, claimedPath);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return;
    }
    throw cause;
  }

  try {
    return {
      claimedPath,
      endpoint,
      restore: !ownsClaim(claimedPath),
      verification: { failed: false },
    };
  } catch (cause) {
    return {
      claimedPath,
      endpoint,
      restore: true,
      verification: { cause, failed: true },
    };
  }
};

export const guardLocalMigrateServerEndpoint = (
  endpoint: string,
  ownsGuard: (guardPath: string) => boolean
): LocalMigrateServerEndpointClaim | undefined => {
  const guardPath = `${endpoint}.${process.pid}.${randomUUID()}.guard`;
  try {
    linkSync(endpoint, guardPath);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return;
    }
    throw cause;
  }

  try {
    return {
      claimedPath: guardPath,
      endpoint,
      restore: !ownsGuard(guardPath),
      verification: { failed: false },
    };
  } catch (cause) {
    return {
      claimedPath: guardPath,
      endpoint,
      restore: true,
      verification: { cause, failed: true },
    };
  }
};

export const settleLocalMigrateServerEndpointClaim = (
  claim: LocalMigrateServerEndpointClaim
): void => {
  const removeClaim = () => {
    try {
      unlinkSync(claim.claimedPath);
    } catch (cause) {
      if (
        !(cause instanceof Error && "code" in cause) ||
        (cause as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw cause;
      }
    }
  };
  const restoreClaim = () => {
    try {
      linkSync(claim.claimedPath, claim.endpoint);
    } catch (cause) {
      if (
        !(cause instanceof Error && "code" in cause) ||
        (cause as NodeJS.ErrnoException).code !== "EEXIST"
      ) {
        throw cause;
      }
    }
  };

  try {
    if (claim.restore) {
      restoreClaim();
    }
  } catch (cause) {
    if (claim.verification.failed) {
      throw new AggregateError(
        [claim.verification.cause, cause],
        "Migrate Server endpoint ownership verification failed and its claim could not be restored"
      );
    }
    throw cause;
  }

  removeClaim();

  if (claim.verification.failed) {
    throw claim.verification.cause;
  }
};

export const makeLocalMigrateServerEndpoint = (
  { buildId, configPath, cwd }: LocalMigrateServerEndpointInput,
  environment: LocalMigrateServerEndpointEnvironment
): string => {
  const identity = JSON.stringify({
    buildId,
    configPath: configPath === undefined ? undefined : resolve(cwd, configPath),
    cwd: resolve(cwd),
    sdkVersion: environment.sdkVersion,
    serverIdentity: environment.serverIdentity,
  });
  const digest = createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 24);
  const name = `migrate-${environment.user}-${digest}`;

  return environment.platform === "win32"
    ? join(environment.tempDirectory, `${name}.json`)
    : join(environment.tempDirectory, `${name}.sock`);
};

export const removeLocalMigrateServerEndpoint = (
  endpoint: string,
  platform: NodeJS.Platform = process.platform,
  expectedDiscovery?: string,
  expectedPosixIdentity?: LocalMigrateServerPosixEndpointIdentity
): void => {
  if (platform === "win32") {
    if (expectedDiscovery === undefined) {
      return;
    }

    const claim = claimLocalMigrateServerEndpoint(
      endpoint,
      (claimedPath) => readFileSync(claimedPath, "utf8") === expectedDiscovery
    );
    if (claim !== undefined) {
      settleLocalMigrateServerEndpointClaim(claim);
    }

    return;
  }

  if (expectedPosixIdentity === undefined) {
    return;
  }

  const claim = claimLocalMigrateServerEndpoint(endpoint, (claimedPath) => {
    const claimedIdentity =
      readLocalMigrateServerPosixEndpointIdentity(claimedPath);
    return (
      claimedIdentity !== undefined &&
      samePosixEndpointIdentity(claimedIdentity, expectedPosixIdentity)
    );
  });
  if (claim !== undefined) {
    settleLocalMigrateServerEndpointClaim(claim);
  }
};

export const publishLocalMigrateServerTcpDiscovery = (
  endpoint: string,
  discovery: string
): void => {
  const temporaryPath = `${endpoint}.${process.pid}.${randomUUID()}.tmp`;
  const removeTemporaryFile = () => {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Best effort: the published endpoint is a separate hard link.
    }
  };

  try {
    writeFileSync(temporaryPath, discovery, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    linkSync(temporaryPath, endpoint);
  } catch (cause) {
    removeTemporaryFile();
    throw cause;
  }

  removeTemporaryFile();
};
