#!/usr/bin/env node
// Record the SDK's public surface, and fail when anything leaves it.
//
// The release gate is oasdiff, which compares the schema. What we publish is
// a client generated from that schema, and the two disagree about what is
// breaking. Renaming a component schema, changing an operationId, moving an
// operation to another tag or renaming a parameter are all `info` to oasdiff,
// since nothing on the wire changes, while each one renames or deletes
// something a consumer imports or calls. sdk-python has the same gate in
// scripts/api_surface.py, and this follows it.
//
// So this reads the built declarations rather than the schema, writes the
// surface to a file we commit, and on the next release fails if any line
// disappeared. Additions are fine; removals are not.
//
// One line per name, not per declaration: a composite line would be
// rewritten whenever anything on it changed, so adding a field would read as
// a removal and halt an entirely additive release. Optionality is part of the
// line, so a property becoming required removes the optional line, which is
// the break it is. Parameters are recorded by position, not name: a caller
// passes them positionally, so a generator renaming its parameters is not a
// false alarm. Each has a `#n` line, and an optional one also a `#n?` line, so
// a parameter becoming required removes `#n?`, while one becoming optional
// only adds a line.
//
// Types are not recorded: oasdiff already rates a changed property or
// parameter type as breaking, and TypeScript's printed types churn with the
// compiler version.
//
//   node scripts/api-surface.mjs write dist/esm/index.d.ts api-surface.txt
//   node scripts/api-surface.mjs check dist/esm/index.d.ts api-surface.txt

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

function isHidden(declaration) {
  const flags = ts.getCombinedModifierFlags(declaration);
  return (flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !== 0;
}

function isOptionalParameter(parameter) {
  const declaration = parameter.valueDeclaration;
  return Boolean(
    declaration && ts.isParameter(declaration) && (declaration.questionToken || declaration.initializer),
  );
}

function signatureLines(prefix, signatures) {
  const lines = [];
  signatures.forEach((signature, overload) => {
    const tag = signatures.length > 1 ? ` overload${overload}` : "";
    signature.parameters.forEach((parameter, position) => {
      lines.push(`${prefix}${tag} #${position}`);
      if (isOptionalParameter(parameter)) lines.push(`${prefix}${tag} #${position}?`);
    });
  });
  return lines;
}

// The build's own compiler options, so the declarations resolve the same
// global types here as they did when they were emitted.
function buildOptions() {
  const config = ts.getParsedCommandLineOfConfigFile("tsconfig.json", {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  });
  return { ...config.options, noEmit: true };
}

// A class's instance members, then its static ones, recorded alike.
function memberLines(checker, name, members) {
  const lines = [];
  for (const member of members) {
    const declaration = member.declarations?.[0];
    if (!declaration || isHidden(declaration) || member.getName() === "__constructor") continue;
    const prefix = `class ${name}.${member.getName()}`;
    lines.push(prefix);
    if (member.flags & ts.SymbolFlags.Method) {
      const type = checker.getTypeOfSymbolAtLocation(member, declaration);
      lines.push(...signatureLines(prefix, type.getCallSignatures()));
    }
  }
  return lines;
}

function surface(entry) {
  const program = ts.createProgram([entry], buildOptions());
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  if (!source) throw new Error(`cannot read ${entry}`);

  const lines = [];
  for (const exported of checker.getExportsOfModule(checker.getSymbolAtLocation(source))) {
    const symbol =
      exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const name = exported.getName();

    if (symbol.flags & ts.SymbolFlags.Class) {
      lines.push(`class ${name}`);
      const constructorType = checker.getTypeOfSymbol(symbol);
      lines.push(...signatureLines(`class ${name} constructor`, constructorType.getConstructSignatures()));
      lines.push(...memberLines(checker, name, symbol.members?.values() ?? []));
      // `prototype` is on every class and is not API.
      const statics = [...(symbol.exports?.values() ?? [])].filter((member) => member.getName() !== "prototype");
      lines.push(...memberLines(checker, `${name} static`, statics));
    }

    if (symbol.flags & ts.SymbolFlags.Interface) {
      lines.push(`interface ${name}`);
      for (const member of symbol.members?.values() ?? []) {
        if (!(member.flags & (ts.SymbolFlags.Property | ts.SymbolFlags.Method))) continue;
        const optional = member.flags & ts.SymbolFlags.Optional ? "?" : "";
        const prefix = `interface ${name}.${member.getName()}${optional}`;
        lines.push(prefix);
        if (member.flags & ts.SymbolFlags.Method) {
          // An optional method is typed `T | undefined`, which has no signatures.
          const type = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(member, member.declarations[0]));
          lines.push(...signatureLines(prefix, type.getCallSignatures()));
        }
      }
    }

    // The generator emits no TypeScript enums today; this records one if a
    // future version starts to.
    if (symbol.flags & ts.SymbolFlags.Enum) {
      lines.push(`enum ${name}`);
      for (const member of symbol.exports?.values() ?? []) {
        lines.push(`enum ${name}.${member.getName()} = ${checker.typeToString(checker.getTypeOfSymbol(member))}`);
      }
    }

    if (symbol.flags & ts.SymbolFlags.TypeAlias) {
      lines.push(`type ${name}`);
    }

    if (symbol.flags & ts.SymbolFlags.Function) {
      lines.push(`function ${name}`);
      const type = checker.getTypeOfSymbol(symbol);
      lines.push(...signatureLines(`function ${name}`, type.getCallSignatures()));
    }

    // The generator's enums are `const X = { Member: 'value' } as const`, so
    // each member is recorded with its value: a value the API stops sending
    // is a removal, and so is a member renamed around an unchanged value.
    // Only literal members count. Any other const's properties are methods
    // of String or Configuration, whose printed types move with the compiler,
    // not with our API.
    if (symbol.flags & ts.SymbolFlags.Variable) {
      lines.push(`const ${name}`);
      for (const property of checker.getTypeOfSymbol(symbol).getProperties()) {
        const type = checker.getTypeOfSymbol(property);
        if (type.flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BooleanLiteral)) {
          lines.push(`const ${name}.${property.getName()} = ${checker.typeToString(type)}`);
        }
      }
    }
  }
  return [...new Set(lines)].sort();
}

function printCapped(lines, marker, log) {
  for (const line of lines.slice(0, 40)) log(`  ${marker} ${line}`);
  if (lines.length > 40) log(`  ... and ${lines.length - 40} more`);
}

function check(current, recordedPath) {
  if (!existsSync(recordedPath)) {
    console.error(`${recordedPath} does not exist. Run \`make surface\` to create it.`);
    return 1;
  }
  const recorded = new Set(readFileSync(recordedPath, "utf8").split("\n").filter(Boolean));
  const now = new Set(current);
  const removed = [...recorded].filter((line) => !now.has(line));
  const added = current.filter((line) => !recorded.has(line));

  printCapped(added, "+", console.log);

  if (removed.length === 0) {
    console.log(`surface: ${current.length} entries, ${added.length} added, nothing removed`);
    return 0;
  }

  console.error(`\n${removed.length} entries left the public surface:`);
  printCapped(removed, "-", console.error);
  console.error(
    "\nConsumers import and call these by name, so removing one breaks them even" +
      " when the wire contract is unchanged. This needs a major version, not the" +
      " automatic minor bump. After deciding to cut one, run `make surface` to" +
      " accept the new surface.",
  );
  return 1;
}

const [command, entry, path] = process.argv.slice(2);
if (!["write", "check"].includes(command) || !entry || !path) {
  console.error("usage: api-surface.mjs <write|check> <index.d.ts> <surface-file>");
  process.exit(2);
}

const current = surface(entry);
if (command === "write") {
  writeFileSync(path, current.join("\n") + "\n");
  console.log(`surface: wrote ${current.length} entries to ${path}`);
} else {
  process.exit(check(current, path));
}
