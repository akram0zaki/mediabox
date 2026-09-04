/**
 * "People to keep clear": a small gallery of known faces (embeddings + thumbnails) that the
 * face-mask operation consults. Kept in a module registry so the render pipeline can read it
 * without threading it through operation params; the store persists it to localStorage.
 */
import { cosine } from './recognizer';

export interface PersonSample {
  embedding: number[];
  /** Small JPEG data URL of the face, for the UI. */
  thumb: string;
}

export interface Person {
  id: string;
  name: string;
  samples: PersonSample[];
}

let people: Person[] = [];

export function setPeople(next: Person[]): void {
  people = next;
}

export function getPeople(): Person[] {
  return people;
}

export interface Match {
  person: Person;
  similarity: number;
}

/** Best-matching person for an embedding, or null if nobody exceeds the threshold. */
export function matchPerson(embedding: ArrayLike<number>, threshold: number): Match | null {
  let best: Match | null = null;
  for (const person of people) {
    for (const sample of person.samples) {
      const similarity = cosine(embedding, sample.embedding);
      if (similarity >= threshold && (!best || similarity > best.similarity)) best = { person, similarity };
    }
  }
  return best;
}

export function newPersonId(): string {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
