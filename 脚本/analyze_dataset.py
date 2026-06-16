from elasticsearch import Elasticsearch
import os
import warnings
from urllib3.exceptions import InsecureRequestWarning

warnings.simplefilter('ignore', InsecureRequestWarning)

es = Elasticsearch(
    os.environ.get('ES_URL') or 'https://127.0.0.1:9200/',
    basic_auth=(os.environ.get('ES_USERNAME') or 'elastic', os.environ.get('ES_PASSWORD') or 'Lijunwei111'),
    verify_certs=False,
    ssl_show_warn=False,
    request_timeout=120,
)

index_name = os.environ.get('ES_INDEX_NAME', 'senren_dialogues')

print('=== 数据集质量分析 ===')
print()

print('=== 标签分布分析 ===')
result = es.search(
    index=index_name,
    size=0,
    aggs={
        'scene_tags': {'terms': {'field': 'all_tags', 'size': 30}},
        'dense_vector_stats': {
            'stats': {'field': 'text_length'}
        }
    }
)

print('--- 高频标签 (前30) ---')
for bucket in result['aggregations']['scene_tags']['buckets']:
    key = bucket['key']
    count = bucket['doc_count']
    print(f'  {key}: {count} 次')

print()
print('--- 文本长度统计 ---')
stats = result['aggregations']['dense_vector_stats']
print(f"  最小值: {stats['min']} 字符")
print(f"  最大值: {stats['max']} 字符")
print(f"  平均值: {stats['avg']:.1f} 字符")
print(f"  标准差: {stats.get('std_deviation', 'N/A')}")

print()
print('=== 可扮演角色统计 ===')
result2 = es.search(
    index=index_name,
    size=0,
    query={'term': {'is_playable': True}},
    aggs={
        'playable_characters': {'terms': {'field': 'character', 'size': 20}}
    }
)

print('--- 可扮演角色的台词数量 ---')
for bucket in result2['aggregations']['playable_characters']['buckets']:
    key = bucket['key']
    count = bucket['doc_count']
    print(f'  {key}: {count} 条')

print()
print('=== 数据集完整性检查 ===')
result3 = es.search(
    index=index_name,
    size=0,
    query={
        'bool': {
            'should': [
                {'bool': {'must_not': {'exists': {'field': 'text'}}}},
                {'bool': {'must_not': {'exists': {'field': 'text_norm'}}}},
                {'bool': {'must_not': {'exists': {'field': 'dense_vector'}}}},
                {'bool': {'must_not': {'exists': {'field': 'source_id'}}}},
            ],
            'minimum_should_match': 1
        }
    }
)
missing_count = result3['hits']['total']['value']
print(f"存在缺失关键字段的文档数: {missing_count}")

print()
print('=== 章节覆盖统计 ===')
result4 = es.search(
    index=index_name,
    size=0,
    aggs={
        'chapter_major': {'terms': {'field': 'chapter_major', 'size': 20}},
        'chapter_minor': {'terms': {'field': 'chapter_minor', 'size': 20}}
    }
)

print('--- 大章节分布 ---')
for bucket in result4['aggregations']['chapter_major']['buckets']:
    key = bucket['key']
    count = bucket['doc_count']
    print(f'  第{key}章: {count} 条')

print()
print('--- 小章节分布 ---')
for bucket in result4['aggregations']['chapter_minor']['buckets']:
    key = bucket['key']
    count = bucket['doc_count']
    print(f'  小节{key}: {count} 条')

print()
print('=== 标签分类统计 ===')
result5 = es.search(
    index=index_name,
    size=0,
    aggs={
        'character_types': {'terms': {'field': 'character_type', 'size': 10}}
    }
)

print('--- 角色类型分布 ---')
for bucket in result5['aggregations']['character_types']['buckets']:
    key = bucket['key']
    count = bucket['doc_count']
    print(f'  {key}: {count} 条')

print()
print('分析完成！')
