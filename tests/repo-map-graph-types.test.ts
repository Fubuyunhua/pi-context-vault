import { expectTypeOf, it } from "vitest";
import type {
  ExternalModuleEdge,
  ExternalModuleId,
  FileId,
  GraphAssemblyEdge,
  ReferenceId,
  ResolvedFileEdge,
  SymbolId,
  UnresolvedReferenceEdge,
} from "../src/repo-map/graph.js";

type DeclaresEdge = Extract<GraphAssemblyEdge, { relation: "DECLARES" }>;
type ExportNameEdge = Extract<GraphAssemblyEdge, { relation: "EXPORTS_NAME" }>;
type HeritageEdge = Extract<GraphAssemblyEdge, { relation: "JAVA_EXTENDS_NAME" }>;
type ProvisionalImportEdge = Extract<GraphAssemblyEdge, { relation: "IMPORTS_FILE" }>;
type RelationCorrelation = GraphAssemblyEdge extends infer Edge
  ? Edge extends { relation: infer Relation; descriptor: { relation: infer DescriptorRelation } }
    ? Relation extends DescriptorRelation
      ? DescriptorRelation extends Relation
        ? true
        : false
      : false
    : false
  : false;

it("statically correlates every S02b assembly descriptor and endpoint", () => {
  expectTypeOf<RelationCorrelation>().toEqualTypeOf<true>();
  expectTypeOf<DeclaresEdge["sourceId"]>().toEqualTypeOf<FileId>();
  expectTypeOf<DeclaresEdge["targetId"]>().toEqualTypeOf<SymbolId>();
  expectTypeOf<DeclaresEdge["descriptor"]["relation"]>().toEqualTypeOf<"DECLARES">();
  expectTypeOf<ExportNameEdge["sourceId"]>().toEqualTypeOf<FileId>();
  expectTypeOf<ExportNameEdge["referenceId"]>().toEqualTypeOf<ReferenceId>();
  expectTypeOf<ExportNameEdge["descriptor"]["relation"]>().toEqualTypeOf<"EXPORTS_NAME">();
  expectTypeOf<HeritageEdge["sourceId"]>().toEqualTypeOf<SymbolId>();
  expectTypeOf<ProvisionalImportEdge>().toEqualTypeOf<never>();
  expectTypeOf<ResolvedFileEdge["targetId"]>().toEqualTypeOf<FileId>();
  expectTypeOf<ExternalModuleEdge["targetId"]>().toEqualTypeOf<ExternalModuleId>();
  expectTypeOf<UnresolvedReferenceEdge["targetId"]>().toEqualTypeOf<undefined>();
});
