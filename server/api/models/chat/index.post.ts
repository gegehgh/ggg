import { Readable } from 'stream';
import { AIMessage, HumanMessage, BaseMessage } from "@langchain/core/messages";
import { createStuffDocumentsChain } from "langchain/chains/combine_documents";
import { formatDocumentsAsString } from "langchain/util/document";
import { PromptTemplate } from "@langchain/core/prompts";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { RunnablePassthrough, RunnableSequence } from "@langchain/core/runnables";
import { setEventStreamResponse, FetchWithAuth } from '@/server/utils';
import { BaseRetriever } from "@langchain/core/retrievers";
import { StringOutputParser } from "@langchain/core/output_parsers";
import prisma from "@/server/utils/prisma";
import { createChatModel, createEmbeddings } from '@/server/utils/models';
import { createRetriever } from '@/server/retriever';

const SYSTEM_TEMPLATE = `Answer the user's question based on the context below.
Your answer should be in the format of Markdown.

If the context doesn't contain any relevant information to the question, don't make something up and just say "I don't know":

<context>
{context}
</context>

<chat_history>
{chatHistory}
</chat_history>

<question>
{question}
</question>

Answer:
`;

const serializeMessages = (messages: Array<BaseMessage>): string =>
  messages.map((message) => `${message.role}: ${message.content}`).join("\n");

export default defineEventHandler(async (event) => {
  const { knowledgebaseId, model, family, messages, stream } = await readBody(event);

  if (knowledgebaseId) {
    console.log("Chat with knowledge base with id: ", knowledgebaseId);
    const knowledgebase = await prisma.knowledgeBase.findUnique({
      where: {
        id: knowledgebaseId,
      },
    });
    console.log(`Knowledge base ${knowledgebase?.name} with embedding "${knowledgebase?.embedding}"`);
    if (!knowledgebase) {
      setResponseStatus(event, 404, `Knowledge base with id ${knowledgebaseId} not found`);
      return;
    }

    const embeddings = createEmbeddings(knowledgebase.embedding, event);
    const retriever: BaseRetriever = await createRetriever(embeddings, `collection_${knowledgebase.id}`);

    const chat = createChatModel(model, family, event);
    const query = messages[messages.length - 1].content
    console.log("User query: ", query);

    const chain = RunnableSequence.from([
      {
        question: (input: { question: string; chatHistory?: string }) =>
          input.question,
        chatHistory: (input: { question: string; chatHistory?: string }) =>
          input.chatHistory ?? "",
        context: async (input: { question: string; chatHistory?: string }) => {
          const relevant_docs = await retriever.getRelevantDocuments(input.question);
          console.log("Relevant documents: ", relevant_docs);
          return formatDocumentsAsString(relevant_docs);
        },
      },
      PromptTemplate.fromTemplate(SYSTEM_TEMPLATE),
      chat
    ]);

    if (!stream) {
      const response = await chain.invoke({
        question: query,
        chatHistory: serializeMessages(messages),
      });

      return {
        message: {
          role: 'assistant',
          content: response?.content
        }
      };
    }

    setEventStreamResponse(event);
    const response = await chain.stream({
      question: query,
      chatHistory: serializeMessages(messages),
    });

    const readableStream = Readable.from((async function* () {
      for await (const chunk of response) {
        if (chunk?.content !== undefined) {
          const message = {
            message: {
              role: 'assistant',
              content: chunk?.content
            }
          };
          yield `${JSON.stringify(message)}\n\n`;
        }
      }
    })());
    return sendStream(event, readableStream);
  } else {
    const llm = createChatModel(model, family, event);
    const response = await llm?.stream(messages.map((message: BaseMessage) => {
      return [message.role, message.content];
    }));

    const readableStream = Readable.from((async function* () {
      for await (const chunk of response) {
        const message = {
          message: {
            role: 'assistant',
            content: chunk?.content
          }
        };
        yield `${JSON.stringify(message)}\n\n`;
      }
    })());

    return sendStream(event, readableStream);
  }
})
