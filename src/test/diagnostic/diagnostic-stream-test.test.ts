/**
 * [DIAGNOSTIC ONLY - NOT FOR REGULAR CI]
 *
 * Diagnostic Test: Stream State Tracking
 *
 * Purpose: This test will identify EXACTLY where the stream gets locked
 * between callGPT5ResponsesAPI and adapter.parseResponse()
 *
 * The issue: CLI returns empty content, but integration tests pass.
 * This suggests something is consuming the stream before the adapter reads it.
 */

import { test, expect, describe } from 'vitest'
import { ModelAdapterFactory } from '../../services/modelAdapterFactory'
import { callGPT5ResponsesAPI } from '../../services/openai'

const GPT5_CODEX_PROFILE = {
  name: 'gpt-5-codex',
  provider: 'openai',
  modelName: 'gpt-5-codex',
  baseURL: process.env.TEST_GPT5_BASE_URL || 'http://127.0.0.1:3000/openai',
  apiKey: process.env.TEST_GPT5_API_KEY || '',
  maxTokens: 8192,
  contextLength: 128000,
  reasoningEffort: 'high',
  isActive: true,
  createdAt: Date.now(),
}

describe('🔍 Diagnostic: Stream State Tracking', () => {
  test('Track stream locked state through the entire pipeline', async () => {
    console.log('\n🔍 DIAGNOSTIC TEST: Stream State Tracking')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

    // Step 1: Create adapter
    console.log('\nStep 1: Creating adapter...')
    const adapter = ModelAdapterFactory.createAdapter(GPT5_CODEX_PROFILE)
    console.log(`  ✅ Adapter: ${adapter.constructor.name}`)

    // Step 2: Build request with STREAMING enabled (this is the key!)
    console.log('\nStep 2: Building request with streaming...')
    const unifiedParams = {
      messages: [{ role: 'user', content: 'Hello, write 3 words.' }],
      systemPrompt: ['You are a helpful assistant.'],
      tools: [],
      maxTokens: 50,
      stream: true, // Force streaming mode (even though adapter forces it anyway)
      reasoningEffort: 'high' as const,
      temperature: 1,
      verbosity: 'high' as const
    }
    console.log('  ✅ Unified params built with stream: true')

    // Step 3: Create request
    console.log('\nStep 3: Creating request...')
    const request = adapter.createRequest(unifiedParams)
    console.log('  ✅ Request created')
    console.log(`  📝 Stream in request: ${request.stream}`)

    // Step 4: Make API call
    console.log('\nStep 4: Making API call (STREAMING)...')
    const response = await callGPT5ResponsesAPI(GPT5_CODEX_PROFILE, request)

    // Step 5: TRACK STREAM STATE before adapter
    console.log('\nStep 5: Checking stream state BEFORE adapter...')
    console.log(`  📊 Response status: ${response.status}`)
    console.log(`  📊 Response ok: ${response.ok}`)
    console.log(`  📊 Response type: ${response.type}`)
    console.log(`  📊 Response body exists: ${!!response.body}`)
    console.log(`  📊 Response body locked: ${response.body?.locked || 'N/A (not a ReadableStream)'}`)

    // Step 6: Check if body is a ReadableStream
    if (response.body && typeof response.body.getReader === 'function') {
      console.log(`  ✅ Confirmed: Response.body is a ReadableStream`)

      // Check initial state
      console.log(`  🔒 Initial locked state: ${response.body.locked}`)

      if (response.body.locked) {
        console.log('\n❌ CRITICAL ISSUE FOUND: Stream is already locked!')
        console.log('   This means something consumed the stream BEFORE adapter.parseResponse()')
        console.log('   Possible culprits:')
        console.log('   - Middleware/interceptor reading the response')
        console.log('   - Debug logging calling response.json() or response.text()')
        console.log('   - Error handler accessing the body')
        throw new Error('Stream locked before adapter.parseResponse() - investigate what consumed it!')
      }
    } else {
      console.log('  ⚠️  WARNING: Response.body is NOT a ReadableStream')
      console.log('   This might be because:')
      console.log('   - The API returned a non-streaming response')
      console.log('   - The response was already consumed and converted')
    }

    // Step 7: Parse response
    console.log('\nStep 6: Parsing response with adapter...')
    let unifiedResponse
    try {
      unifiedResponse = await adapter.parseResponse(response)
      console.log('  ✅ Response parsed successfully')
    } catch (error) {
      console.log('  ❌ Error parsing response:')
      console.log(`   Message: ${error.message}`)
      console.log(`   Stack: ${error.stack}`)

      if (error.message.includes('locked') || error.message.includes('reader')) {
        console.log('\n💡 ROOT CAUSE IDENTIFIED:')
        console.log('   The stream was locked between API call and parseResponse()')
        console.log('   This is the exact bug causing empty content in the CLI!')
      }

      throw error
    }

    // Step 8: Validate result
    console.log('\nStep 7: Validating result...')
    console.log(`  📄 Response ID: ${unifiedResponse.id}`)
    console.log(`  📄 Content type: ${Array.isArray(unifiedResponse.content) ? 'array' : typeof unifiedResponse.content}`)
    console.log(`  📄 Content length: ${Array.isArray(unifiedResponse.content) ? unifiedResponse.content.length : unifiedResponse.content?.length || 0}`)

    // Extract actual text content
    let actualText = ''
    if (Array.isArray(unifiedResponse.content)) {
      actualText = unifiedResponse.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
    } else if (typeof unifiedResponse.content === 'string') {
      actualText = unifiedResponse.content
    }

    console.log(`  📄 Actual text: "${actualText}"`)
    console.log(`  🔧 Tool calls: ${unifiedResponse.toolCalls.length}`)

    // Assertions
    expect(unifiedResponse).toBeDefined()
    expect(unifiedResponse.content).toBeDefined()
    expect(Array.isArray(unifiedResponse.content)).toBe(true)  // Now expects array!

    if (actualText.length === 0) {
      console.log('\n❌ CONFIRMED BUG: Content is empty!')
      console.log('   This matches the CLI behavior.')
      console.log('   The stream was either:')
      console.log('   1. Already consumed/locked before adapter could read it')
      console.log('   2. Never had data to begin with (API returned empty)')
      console.log('   3. SSE parsing failed (wrong event structure)')
    } else {
      console.log('\n✅ Content received! This test would pass if the bug is fixed.')
    }

    // Final summary
    console.log('\n📊 DIAGNOSTIC SUMMARY:')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log(`  Response OK: ${response.ok}`)
    console.log(`  Body Type: ${typeof response.body}`)
    console.log(`  Body Locked: ${response.body?.locked || 'N/A'}`)
    console.log(`  Content Length: ${actualText.length}`)
    console.log(`  Test Result: ${actualText.length > 0 ? 'PASS' : 'FAIL'}`)
  })

  test('Compare streaming vs non-streaming responses', async () => {
    console.log('\n🔍 COMPARISON TEST: Stream vs Non-Stream')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

    const adapter = ModelAdapterFactory.createAdapter(GPT5_CODEX_PROFILE)

    // Test with stream: true
    console.log('\n📡 Testing with stream: true...')
    const streamingParams = {
      messages: [{ role: 'user', content: 'Say "STREAM".' }],
      systemPrompt: ['You are a helpful assistant.'],
      tools: [],
      maxTokens: 10,
      stream: true,
      reasoningEffort: 'high' as const,
      temperature: 1,
      verbosity: 'high' as const
    }

    const streamingRequest = adapter.createRequest(streamingParams)
    const streamingResponse = await callGPT5ResponsesAPI(GPT5_CODEX_PROFILE, streamingRequest)
    const streamingResult = await adapter.parseResponse(streamingResponse)

    // Extract text from content array
    const streamingText = Array.isArray(streamingResult.content)
      ? streamingResult.content.filter(b => b.type === 'text').map(b => b.text).join('')
      : streamingResult.content

    console.log(`  Stream forced: ${streamingRequest.stream}`)
    console.log(`  Body type: ${typeof streamingResponse.body}`)
    console.log(`  Content: "${streamingText}"`)

    // Test with stream: false (even though adapter forces true)
    console.log('\n📡 Testing with stream: false...')
    const nonStreamingParams = {
      ...streamingParams,
      stream: false
    }

    const nonStreamingRequest = adapter.createRequest(nonStreamingParams)
    const nonStreamingResponse = await callGPT5ResponsesAPI(GPT5_CODEX_PROFILE, nonStreamingRequest)
    const nonStreamingResult = await adapter.parseResponse(nonStreamingResponse)

    // Extract text from content array
    const nonStreamingText = Array.isArray(nonStreamingResult.content)
      ? nonStreamingResult.content.filter(b => b.type === 'text').map(b => b.text).join('')
      : nonStreamingResult.content

    console.log(`  Stream requested: ${nonStreamingParams.stream}`)
    console.log(`  Stream forced: ${nonStreamingRequest.stream}`)
    console.log(`  Body type: ${typeof nonStreamingResponse.body}`)
    console.log(`  Content: "${nonStreamingText}"`)

    // Compare
    console.log('\n📊 COMPARISON:')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log(`  Streaming content length: ${streamingText.length}`)
    console.log(`  Non-streaming content length: ${nonStreamingText.length}`)
    console.log(`  Difference: ${nonStreamingText.length - streamingText.length}`)

    if (streamingText.length === 0 && nonStreamingText.length > 0) {
      console.log('\n💡 KEY FINDING:')
      console.log('   The adapter forces stream: true, but returns empty content!')
      console.log('   This suggests the SSE parsing is failing silently.')
    }
  })
})
