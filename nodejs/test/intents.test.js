import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectIntent, extractSearchTopic } from '../src/utils/intents.js';

test('intents: file-creation requests stay in chat, not web search', () => {
  assert.equal(detectIntent('Can you create a config file?').type, 'chat');
  assert.equal(detectIntent('Please write a file called hello.txt').type, 'chat');
  assert.equal(detectIntent('Make a new folder called src').type, 'chat');
  assert.equal(detectIntent('Generate a python script for me').type, 'chat');
  assert.equal(detectIntent('build a project for me').type, 'chat');
});

test('intents: informational questions still trigger web search', () => {
  assert.equal(detectIntent('How do I create a file?').type, 'knowledge');
  assert.equal(detectIntent('What is a json file?').type, 'knowledge');
  assert.equal(detectIntent('Why is my file empty?').type, 'knowledge');
  assert.equal(detectIntent('What is the weather today?').type, 'knowledge');
});

test('intents: greetings are answered instantly', () => {
  assert.equal(detectIntent('hey').type, 'greeting');
  assert.equal(detectIntent('hello').type, 'greeting');
  assert.equal(detectIntent('good morning').type, 'greeting');
  assert.equal(detectIntent('hello there').type, 'chat');
});

test('intents: story-writing requests search the subject first', () => {
  assert.equal(detectIntent('Write me a story about Malin Kundang in a txt file').type, 'knowledge');
  assert.equal(detectIntent('write me a story about malin kundang in a txt file').type, 'knowledge');
  assert.equal(detectIntent('write a file called hello.txt').type, 'chat');
});

test('intents: topic extraction pulls the subject, not the whole sentence', () => {
  assert.equal(extractSearchTopic('Write me a story about Malin Kundang in a txt file'), 'Malin Kundang');
  assert.equal(extractSearchTopic('tell me the story of the phoenix'), 'the phoenix');
  assert.equal(extractSearchTopic('tell me a story about Malin Kundang from indonesia and write it in txt/json format file'), 'Malin Kundang from indonesia');
  assert.equal(extractSearchTopic('Who is Cristiano Ronaldo?'), null);
  assert.equal(extractSearchTopic('hello there'), null);
});

test('intents: any story subject is recognized, not just Malin Kundang', () => {
  assert.equal(extractSearchTopic('tell me about timun mas'), 'timun mas');
  assert.equal(extractSearchTopic('write the legend of roro jonggrang into a txt file'), 'roro jonggrang');
  assert.equal(extractSearchTopic('narrate the tale of bawang putih?'), 'bawang putih');
  assert.equal(extractSearchTopic('tell me the story of sangkuriang from indonesia'), 'sangkuriang from indonesia');
  assert.equal(detectIntent('write the legend of roro jonggrang into a txt file').type, 'knowledge');
  assert.equal(detectIntent('narrate the tale of bawang putih').type, 'knowledge');
  assert.equal(detectIntent('tell me about timun mas').type, 'knowledge');
  assert.equal(detectIntent('tell me about timun mas and save it to a file').type, 'knowledge');
  assert.equal(detectIntent('The legend of Timun Mas from indonesia').type, 'knowledge');
  assert.equal(detectIntent('Can you create a config file?').type, 'chat');
});

test('intents: specific topic and story-of queries trigger web search', () => {
  assert.equal(detectIntent('Malin Kundang from indonesia').type, 'knowledge');
  assert.equal(detectIntent('The legend of Maung from vietnam').type, 'knowledge');
  assert.equal(detectIntent('tell me the story of the phoenix').type, 'knowledge');
  assert.equal(detectIntent('tell me a story about the phoenix').type, 'knowledge');
  assert.equal(detectIntent('I like pizza').type, 'chat');
});

test('intents: generic story requests stay in chat so the AI tells a story', () => {
  assert.equal(detectIntent('tell me a story').type, 'chat');
  assert.equal(detectIntent('hello there').type, 'chat');
});