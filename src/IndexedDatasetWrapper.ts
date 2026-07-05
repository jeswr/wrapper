import type { DataFactory, DatasetCore, Quad, Term } from "@rdfjs/types"
import { DatasetWrapper } from "./DatasetWrapper.js"

/**
 * A {@link DatasetWrapper} that lazily builds a per-subject forward index
 * (subject → predicate → quads) and serves `match(subject, predicate)` calls
 * from it, instead of delegating every call to the underlying dataset.
 *
 * Rationale: mapping accessors ({@link WrappingSet}, {@link OptionalFrom},
 * {@link RequiredFrom}, {@link RdfList}) issue one `match()` per property
 * access. Store implementations typically re-walk their internal index and
 * allocate a fresh result dataset per call, which dominates read-heavy
 * workloads. This wrapper makes repeated reads O(1) map lookups.
 *
 * Mutations performed *through this wrapper* (`add`/`delete`) update the
 * index incrementally. Mutating the underlying dataset directly bypasses
 * invalidation — hold mutations through the wrapper, or call
 * {@link IndexedDatasetWrapper.invalidate} after external writes.
 */
export class IndexedDatasetWrapper extends DatasetWrapper {
    private index: Map<string, Map<string, QuadArrayDataset>> | undefined

    public constructor(dataset: DatasetCore, factory: DataFactory) {
        super(dataset, factory)
    }

    public override add(quad: Quad): this {
        super.add(quad)
        if (this.index) {
            this.bucket(quad.subject, quad.predicate, true)!.quads.push(quad)
        }
        return this
    }

    public override delete(quad: Quad): this {
        super.delete(quad)
        if (this.index) {
            const bucket = this.bucket(quad.subject, quad.predicate, false)
            if (bucket) {
                const i = bucket.quads.findIndex(q => q.equals(quad))
                if (i !== -1) {
                    bucket.quads.splice(i, 1)
                }
            }
        }
        return this
    }

    public override match(subject?: Term, predicate?: Term, object?: Term, graph?: Term): DatasetCore {
        // Fast path: the accessor pattern — subject and predicate bound, object/graph wildcards.
        if (subject && predicate && !object && !graph) {
            if (!this.index) {
                this.buildIndex()
            }
            return this.index!.get(key(subject))?.get(key(predicate)) ?? EMPTY_DATASET
        }
        return super.match(subject, predicate, object, graph)
    }

    /** Drops the index; it is rebuilt on the next indexed read. Call after mutating the underlying dataset directly. */
    public invalidate(): void {
        this.index = undefined
    }

    private buildIndex(): void {
        const index = new Map<string, Map<string, QuadArrayDataset>>()
        for (const quad of this) {
            const s = key(quad.subject)
            let forSubject = index.get(s)
            if (!forSubject) {
                forSubject = new Map()
                index.set(s, forSubject)
            }
            const p = key(quad.predicate)
            let forPredicate = forSubject.get(p)
            if (!forPredicate) {
                forPredicate = new QuadArrayDataset([])
                forSubject.set(p, forPredicate)
            }
            forPredicate.quads.push(quad)
        }
        this.index = index
    }

    private bucket(subject: Term, predicate: Term, create: boolean): QuadArrayDataset | undefined {
        const s = key(subject)
        let forSubject = this.index!.get(s)
        if (!forSubject) {
            if (!create) {
                return undefined
            }
            forSubject = new Map()
            this.index!.set(s, forSubject)
        }
        const p = key(predicate)
        let forPredicate = forSubject.get(p)
        if (!forPredicate) {
            if (!create) {
                return undefined
            }
            forPredicate = new QuadArrayDataset([])
            forSubject.set(p, forPredicate)
        }
        return forPredicate
    }
}

function key(term: Term): string {
    // Subjects and predicates are named nodes, blank nodes or variables.
    // Named nodes (the overwhelmingly common case) are keyed by their IRI with
    // no string allocation; an IRI can never start with "_:" or "?", so the
    // prefixed forms cannot collide with it.
    switch (term.termType) {
        case "NamedNode": return term.value
        case "BlankNode": return "_:" + term.value
        default: return "?" + term.termType + "|" + term.value
    }
}

/**
 * Minimal read-only DatasetCore over a quad array — the result of an indexed match.
 *
 * Note: results are a *live view* of the indexed bucket (they reflect subsequent
 * `add`/`delete` calls on the owning {@link IndexedDatasetWrapper}), matching the
 * live-view behavior of common store implementations such as N3.Store.
 */
class QuadArrayDataset implements DatasetCore {
    public constructor(public readonly quads: Quad[]) {
    }

    public get size(): number {
        return this.quads.length
    }

    public* [Symbol.iterator](): Iterator<Quad> {
        yield* this.quads
    }

    public add(_quad: Quad): this {
        throw new Error("match results are read-only")
    }

    public delete(_quad: Quad): this {
        throw new Error("match results are read-only")
    }

    public has(quad: Quad): boolean {
        return this.quads.some(q => q.equals(quad))
    }

    public match(subject?: Term, predicate?: Term, object?: Term, graph?: Term): DatasetCore {
        return new QuadArrayDataset(this.quads.filter(q =>
            (!subject || q.subject.equals(subject))
            && (!predicate || q.predicate.equals(predicate))
            && (!object || q.object.equals(object))
            && (!graph || q.graph.equals(graph))))
    }
}

const EMPTY_DATASET = new QuadArrayDataset([])
