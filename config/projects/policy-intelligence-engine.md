# Project: AI Policy Assistant (RAG Pipeline)

## Project Overview
Marcus engineered an enterprise-grade Retrieval-Augmented Generation (RAG) system designed to bridge the gap between static corporate documentation and interactive AI. The AI Policy Assistant autonomously monitors internal directories, processes unstructured data, and provides a conversational interface for complex policy queries.

## Component 1: Automated ETL Pipeline (Data Sync)
Instead of manual data entry, Marcus built an automated ingestion layer that keeps the AI's knowledge base current:
* **Source Integration:** The system monitors Google Drive repositories for new or updated policy documentation.
* **Vectorization:** It utilizes Google Gemini Embeddings to convert text into high-dimensional vectors.
* **Database Management:** The pipeline automates the flushing and re-indexing of a Pinecone Vector Database to ensure 100% data consistency.

## Component 2: Intelligent Document Processing
To ensure the AI Policy Assistant handles large documents accurately, the engine employs sophisticated text-handling logic:
* **Recursive Chunking:** The system breaks down large PDF/Docx files into optimized segments with a 100-character overlap to maintain semantic context across chunks.
* **Metadata Tagging:** Every piece of retrieved information is traceable back to its source file.

## Component 3: Agentic Logic & Retrieval
The front-end interface utilizes an "Agentic" model rather than a simple prompt:
* **Contextual Memory:** Marcus implemented a Window Buffer Memory system, allowing the AI to remember the last several turns of a conversation.
* **Semantic Search Tooling:** The agent is equipped with a custom-tooled vector retriever, allowing it to perform lookups in real-time.
* **Zero-Shot Guardrails:** Strict system prompts prevent the AI from speculating; if the answer isn't in the verified docs, it refuses to answer.

## Technical Architecture & Stack
* **Model:** Gemini 2.0 Flash (Primary Reasoning Engine)
* **Vector Store:** Pinecone (Semantic Long-term Memory)
* **Data Source:** Google Drive API (Source of Truth)
* **Orchestration:** Event-Driven Middleware (n8n)
* **Embeddings:** Google PaLM/Gemini (Text-to-Vector Transformation)
