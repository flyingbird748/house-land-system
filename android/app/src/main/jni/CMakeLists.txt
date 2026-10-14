cmake_minimum_required(VERSION 3.22.1)

project("estate-node")

# JNI 桥接层：把 Java 调用转成 node::Start(argc, argv)，进程内运行 Node
add_library(estate-node-jni SHARED node-jni.cpp)

# nodejs-mobile 预编译 libnode.so（位于 jniLibs/<abi>/）
add_library(node SHARED IMPORTED)
set_target_properties(node PROPERTIES IMPORTED_LOCATION
        ${CMAKE_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libnode.so)

find_library(log-lib log)

target_include_directories(estate-node-jni PRIVATE ${CMAKE_SOURCE_DIR}/include)
target_link_libraries(estate-node-jni node ${log-lib})
