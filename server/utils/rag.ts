import { Document } from "@langchain/core/documents"
import { PDFLoader } from "langchain/document_loaders/fs/pdf"
import { TextLoader } from "langchain/document_loaders/fs/text"
import { JSONLoader } from "langchain/document_loaders/fs/json"
import { DocxLoader } from "langchain/document_loaders/fs/docx"
import { CSVLoader } from "langchain/document_loaders/fs/csv"
import { compile } from "html-to-text"
import { MultiPartData, H3Event } from 'h3'
import { createRetriever } from '@/server/retriever'
import type { PageParser } from '@/server/types'
import { RecursiveUrlLoader, type RecursiveUrlLoaderOptions } from '@/server/utils/recursiveUrlLoader'
import { KnowledgeBase } from '@prisma/client'

export const loadDocuments = async (file: MultiPartData) => {
  const Loaders = {
    pdf: PDFLoader,
    json: JSONLoader,
    csv: CSVLoader,
    docx: DocxLoader,
    doc: DocxLoader,
    txt: TextLoader,
    md: TextLoader,
  } as const

  const ext = (file.filename?.match(/\.(\w+)$/)?.[1] || 'txt').toLowerCase() as keyof typeof Loaders
  if (!Loaders[ext]) {
    throw new Error(`Unsupported file type: ${ext}`)
  }
  const blob = new Blob([file.data], { type: file.type })
  return new Loaders[ext](blob).load()
}

interface LoadUrlOptions {
  pageParser: PageParser
  maxDepth?: number
  excludeGlobs?: string[]
}

export const loadURL = async (url: string, options: LoadUrlOptions) => {
  console.log('Entry URL:', url, options.pageParser)
  let loaderOptions: RecursiveUrlLoaderOptions = {
    maxDepth: options.maxDepth ?? 0,
    callerOptions: {
      maxRetries: 1,
    },
    timeout: 5000,
    excludeGlobs: options.excludeGlobs ?? [],
  }

  if (options.pageParser === 'jinaReader') {
    loaderOptions.fetch = (url, options) => {
      return fetch(`https://r.jina.ai/${url}`, options)
    }
    loaderOptions.extractMetadata = (text, url) => {
      return {
        source: url,
        title: text.trim().match(/(?<=^Title: ).+/)?.[0] ?? ''
      }
    }
  } else {
    loaderOptions.extractor = compile({ wordwrap: 130 })
  }

  const loader = new RecursiveUrlLoader(url, loaderOptions)
  const docs = await loader.load()

  return docs
}

export const ingestDocument = async (
  files: MultiPartData[],
  knowledgeBase: KnowledgeBase,
  collectionName: string,
  embedding: string,
  event: H3Event
) => {
  const docs = []

  for (const file of files) {
    const createdKnowledgeBaseFile = await prisma.knowledgeBaseFile.create({
      data: {
        url: file.filename!,
        knowledgeBaseId: knowledgeBase.id,
        status: 0
      }
    })

    console.log(`KnowledgeBaseFile with ID: ${createdKnowledgeBaseFile.id}, status 0`)

    const loadedDocs = await loadDocuments(file)
    loadedDocs.forEach((doc) => doc.metadata.source = file.filename)
    docs.push(...loadedDocs)

    await prisma.knowledgeBaseFile.update({
      where: {
        id: createdKnowledgeBaseFile.id
      },
      data: {
        status: 1
      }
    })

    console.log(`Updated KnowledgeBaseFile with ID: ${createdKnowledgeBaseFile.id} to status 1`)
  }

  const embeddings = createEmbeddings(embedding, event)
  await createRetriever(embeddings, collectionName, docs)

  console.log(`${docs.length} documents added to collection ${collectionName}.`)
}

export const ingestURLs = async (
  urls: string[],
  knowledgeBase: KnowledgeBase,
  collectionName: string,
  embedding: string,
  event: H3Event
) => {
  const embeddings = createEmbeddings(embedding, event)
  const retriever = await createRetriever(embeddings, collectionName)
  const entryAndChildUrls = new Set<string>()
  const { pageParser, maxDepth, excludeGlobs } = await parseKnowledgeBaseFormRequest(event)

  for (const url of urls) {
    const loadedDocs = await loadURL(url, { pageParser, maxDepth, excludeGlobs })

    for (const doc of loadedDocs) {
      const url = doc.metadata.source.replace(/\/$/, '')

      const createdKnowledgeBaseFile = await prisma.knowledgeBaseFile.create({
        data: {
          url: url,
          knowledgeBaseId: knowledgeBase.id,
          status: 0
        }
      })

      console.log(`Knowledge base file with URL ${url} created with ID: ${createdKnowledgeBaseFile.id}`)

      await retriever.addDocuments([doc])
      await prisma.knowledgeBaseFile.update({
        where: {
          id: createdKnowledgeBaseFile.id
        },
        data: {
          status: 1
        }
      })

      console.log(`Knowledge base file with URL ${url} updated to status 1`)
    }
    entryAndChildUrls.add(url)
  }
  console.log(`${entryAndChildUrls.size} URLs added to collection ${collectionName}.`)
  console.log('All URLs:', entryAndChildUrls)
}
