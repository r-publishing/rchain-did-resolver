// Copyright 2018 ConsenSys AG

// Licensed under the Apache License, Version 2.0(the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at

// http://www.apache.org/licenses/LICENSE-2.0

// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
//   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as rchainToolkit_ from 'rchain-toolkit'
const rchainToolkit = rchainToolkit_

const {
  readPursesDataTerm,
  readAllPursesTerm,
  decodePurses,
  readBoxTerm
} = require('rchain-token')
import { inflate } from 'pako'
import * as u8a from 'uint8arrays'
import { ec as EC } from 'elliptic'
const ec = new EC('secp256k1')

export interface DIDDocument {
  '@context': 'https://w3id.org/did/v1' | string | string[]
  id: string
  publicKey: PublicKey[]
  authentication?: (string | PublicKey | Authentication)[]
  /**
   * @deprecated This does not appear in the did-core spec
   */
  uportProfile?: any
  service?: ServiceEndpoint[]
  /**
   * @deprecated this property has been removed from the did-core spec
   */
  created?: string
  /**
   * @deprecated this property has been removed from the did-core spec
   */
  updated?: string
  /**
   * @deprecated this property has been removed from the did-core spec
   */
  proof?: LinkedDataProof
  keyAgreement?: (string | PublicKey)[]
}

export interface ServiceEndpoint {
  id: string
  type: string
  serviceEndpoint: string
  description?: string
}

export interface PublicKey {
  id: string
  type: string
  controller: string
  ethereumAddress?: string
  publicKeyBase64?: string
  publicKeyBase58?: string
  publicKeyHex?: string
  publicKeyPem?: string
}

/**
 * @deprecated The `authentication` array should be an array of strings or `PublicKey`
 */
export interface Authentication {
  type: string
  publicKey: string
}

export interface LinkedDataProof {
  type: string
  created: string
  creator: string
  nonce: string
  signatureValue: string
}

export interface Params {
  [index: string]: string
}

export interface ParsedDID {
  did: string
  didUrl: string
  method: string
  id: string
  path?: string
  fragment?: string
  query?: string
  params?: Params
}

export type DIDResolver = (
  did: string,
  parsed: ParsedDID,
  resolver: Resolver
) => Promise<null | DIDDocument>
export type WrappedResolver = () => Promise<null | DIDDocument>
export type DIDCache = (
  parsed: ParsedDID,
  resolve: WrappedResolver
) => Promise<null | DIDDocument>

interface ResolverRegistry {
  [index: string]: DIDResolver
}

export function inMemoryCache(): DIDCache {
  const cache: Map<string, DIDDocument | null> = new Map()
  return async (parsed, resolve) => {
    if (parsed.params && parsed.params['no-cache'] === 'true')
      return await resolve()

    const cached = cache.get(parsed.did)
    if (cached !== undefined) return cached
    const doc = await resolve()
    if (doc !== null) {
      cache.set(parsed.did, doc)
    }
    return doc
  }
}

export function noCache(
  parsed: ParsedDID,
  resolve: WrappedResolver
): Promise<null | DIDDocument> {
  return resolve()
}

const ID_CHAR = '[a-zA-Z0-9_.-]'
const METHOD = '([a-zA-Z0-9_]+)'
const METHOD_ID = `(${ID_CHAR}+(:${ID_CHAR}+)*)`
const PARAM_CHAR = '[a-zA-Z0-9_.:%-]'
const PARAM = `;${PARAM_CHAR}+=${PARAM_CHAR}*`
const PARAMS = `((${PARAM})*)`
const PATH = `(\/[^#?]*)?`
const QUERY = `([?][^#]*)?`
const FRAGMENT = `(\#.*)?`
const DID_MATCHER = new RegExp(
  `^did:${METHOD}:${METHOD_ID}${PARAMS}${PATH}${QUERY}${FRAGMENT}$`
)
export function parse(didUrl: string): ParsedDID {
  if (didUrl === '' || !didUrl) throw new Error('Missing DID')
  const sections = didUrl.match(DID_MATCHER)
  if (sections) {
    const parts: ParsedDID = {
      did: `did:${sections[1]}:${sections[2]}`,
      method: sections[1],
      id: sections[2],
      didUrl
    }
    if (sections[4]) {
      const params = sections[4].slice(1).split(';')
      parts.params = {}
      for (const p of params) {
        const kv = p.split('=')
        parts.params[kv[0]] = kv[1]
      }
    }
    if (sections[6]) parts.path = sections[6]
    if (sections[7]) parts.query = sections[7].slice(1)
    if (sections[8]) parts.fragment = sections[8].slice(1)
    return parts
  }
  throw new Error(`Invalid DID ${didUrl}`)
}

export class Resolver {
  private registry: ResolverRegistry
  private cache: DIDCache

  constructor(
    registry: ResolverRegistry = {},
    cache?: DIDCache | boolean | undefined
  ) {
    this.registry = registry
    this.cache = cache === true ? inMemoryCache() : cache || noCache
  }

  async resolve(didUrl: string): Promise<DIDDocument> {
    const parsed = parse(didUrl)
    const resolver = this.registry[parsed.method]
    if (resolver) {
      const doc = await this.cache(parsed, () =>
        resolver(parsed.did, parsed, this)
      )
      if (doc == null) {
        throw new Error(`resolver returned null for ${parsed.did}`)
      } else {
        return doc
      }
    }
    throw new Error(`Unsupported DID method: '${parsed.method}'`)
  }
}

export function encodeDIDFromPubKey(publicKey: string): string {
  const pubBytes = ec.keyFromPublic(publicKey, 'hex').getPublic(true, 'array')
  const bytes = new Uint8Array(pubBytes.length + 2)
  bytes[0] = 0xe7 // secp256k1 multicodec
  // The multicodec is encoded as a varint so we need to add this.
  // See js-multicodec for a general implementation
  bytes[1] = 0x01
  bytes.set(pubBytes, 2)
  return `did:key:z${u8a.toString(bytes, 'base58btc')}`
}

export function getResolver() {
  async function resolve(
    did: string,
    parsed: ParsedDID,
    didResolver: Resolver
  ): Promise<any> {
    let term

    term = readBoxTerm({
      masterRegistryUri: parsed.id,
      boxId: parsed.path?.substring(1)
    })

    const readBoxResult = await rchainToolkit.http.exploreDeploy(
      'http://localhost:40403',
      {
        term: term
      }
    )

    const box = rchainToolkit.utils.rhoValToJs(
      JSON.parse(readBoxResult).expr[0]
    )

    const didString = encodeDIDFromPubKey(box.publicKey)
    const keyid = didString.substr(8)
    const did2 = didString + '#' + keyid

    const ret = {
      id: didString,
      publicKey: [
        {
          id: did2,
          type: 'Secp256k1VerificationKey2018',
          controller: did2,
          publicKeyHex: box.publicKey
        } as PublicKey
      ]
    } as DIDDocument

    return ret
  }

  return { rchain: resolve }
}
